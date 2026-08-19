'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const logger = require('../utils/logger');
const currency = require('../utils/currency');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { posLimiter } = require('../middleware/rateLimiter');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler, getClientIp, getDeviceInfo, generateSecurityCode, parsePagination } = require('../utils/helpers');
const { isEligibleForOfflineSale, logSyncConflict } = require('../utils/offlineSync');
const { postJournalEntry, paymentAccountCode } = require('../utils/accounting');

const router = express.Router();
router.use(authenticate, posLimiter);

// ==========================================================
// مخططات التحقق
// ==========================================================
const saleItemSchema = Joi.object({
  productId: Joi.string().uuid().required(),
  unitId: Joi.string().uuid().allow(null),
  quantity: Joi.number().positive().required(),
  unitPrice: Joi.number().min(0).required(),
  discountAmount: Joi.number().min(0).default(0),
  taxId: Joi.string().uuid().allow(null)
});

const paymentSchema = Joi.object({
  paymentMethodId: Joi.string().uuid().required(),
  amount: Joi.number().positive().required(),
  referenceNumber: Joi.string().max(100).allow('', null)
});

const saleSchema = Joi.object({
  terminalId: Joi.string().max(50).required(),
  localSequence: Joi.number().integer().min(1).required(),
  customerId: Joi.string().uuid().allow(null),
  shiftId: Joi.string().uuid().required(),
  items: Joi.array().items(saleItemSchema).min(1).required(),
  payments: Joi.array().items(paymentSchema).min(1).required(),
  discountAmount: Joi.number().min(0).default(0),
  taxAmount: Joi.number().min(0).default(0),
  currencyCode: Joi.string().max(10).default('YER'),
  exchangeRate: Joi.number().positive().precision(2).default(1),
  notes: Joi.string().allow('', null),
  isOfflineCreated: Joi.boolean().default(false),
  idempotencyKey: Joi.string().max(100).required()
});

/**
 * POST /api/pos/sale
 * إتمام عملية بيع كاملة (بند 7.1) ضمن معاملة قاعدة بيانات واحدة ذرية.
 * يدعم Idempotency-Key لمنع تكرار الفاتورة عند إعادة الإرسال (بند 10.2).
 */
router.post('/sale', validate(saleSchema), asyncHandler(async (req, res) => {
  const { terminalId, localSequence, customerId, shiftId, items, payments,
    discountAmount, notes, isOfflineCreated, idempotencyKey, currencyCode, exchangeRate } = req.body;
  const userId = req.user.id;
  const ip = getClientIp(req);
  const deviceInfo = getDeviceInfo(req);

  // فحص idempotency: نفس (terminal_id, local_sequence) يعني نفس الفاتورة بالضبط
  const existing = await db.query(
    'SELECT * FROM invoices WHERE terminal_id = $1 AND local_sequence = $2',
    [terminalId, localSequence]
  );
  if (existing.rows.length > 0) {
    return res.status(200).json({ invoice: existing.rows[0], idempotent: true });
  }

  const result = await db.withTransaction(async (client) => {
    // 1. التحقق من الوردية المفتوحة
    const shiftResult = await client.query(
      `SELECT * FROM shifts WHERE id = $1 AND user_id = $2 AND status = 'open' FOR UPDATE`,
      [shiftId, userId]
    );
    if (shiftResult.rows.length === 0) {
      throw new AppError('لا توجد وردية مفتوحة صالحة لهذا المستخدم', 400);
    }
    const shift = shiftResult.rows[0];

    let subtotal = 0;
    let taxTotal = 0;
    let costTotal = 0;
    const preparedItems = [];
    const defaultTaxResult = await client.query(`SELECT id,rate FROM taxes WHERE is_active=true ORDER BY rate DESC LIMIT 1`);
    const defaultTax = defaultTaxResult.rows[0] || null;

    // 2 و 3 و 4. التحقق من المنتجات + قفل صفوف المخزون + الصرف FIFO
    for (const item of items) {
      const productResult = await client.query(
        'SELECT * FROM products WHERE id = $1 AND is_active = true FOR UPDATE',
        [item.productId]
      );
      if (productResult.rows.length === 0) {
        throw new AppError(`المنتج غير موجود أو غير مفعَّل: ${item.productId}`, 400);
      }
      const product = productResult.rows[0];

      let unit = null;
      let baseQty = item.quantity;
      if (item.unitId) {
        const unitResult = await client.query('SELECT * FROM product_units WHERE id = $1', [item.unitId]);
        unit = unitResult.rows[0];
        if (!unit) throw new AppError('وحدة القياس غير موجودة', 400);
        baseQty = currency.round2(item.quantity * unit.base_quantity);
      }

      // إذا كانت الفاتورة أُنشئت offline على الجهاز، تحقق من أهلية البيع offline لهذا المنتج
      if (isOfflineCreated && !isEligibleForOfflineSale(product)) {
        await logSyncConflict(client, {
          tableName: 'products',
          recordId: product.id,
          terminalId,
          conflictType: 'offline_sale_restricted_product',
          details: { productName: product.name }
        });
      }

      if (parseFloat(product.base_quantity) < baseQty) {
        throw new AppError(`الكمية غير كافية من المنتج: ${product.name}`, 400, 'INSUFFICIENT_STOCK');
      }

      // صرف من دفعات المخزون FIFO حسب الأقدم صلاحية
      let remainingToDeduct = baseQty;
      const batchesResult = await client.query(
        `SELECT * FROM inventory_batches
         WHERE product_id = $1 AND quantity_remaining > 0
         ORDER BY expiry_date ASC NULLS LAST, received_date ASC
         FOR UPDATE`,
        [product.id]
      );
      let costPrice = product.base_cost;
      for (const batch of batchesResult.rows) {
        if (remainingToDeduct <= 0) break;
        const deduct = Math.min(parseFloat(batch.quantity_remaining), remainingToDeduct);
        await client.query(
          'UPDATE inventory_batches SET quantity_remaining = quantity_remaining - $1 WHERE id = $2',
          [deduct, batch.id]
        );
        costPrice = batch.purchase_price;
        remainingToDeduct = currency.round2(remainingToDeduct - deduct);
      }

      const qtyBefore = parseFloat(product.base_quantity);
      const qtyAfter = currency.round2(qtyBefore - baseQty);
      await client.query('UPDATE products SET base_quantity = $1 WHERE id = $2', [qtyAfter, product.id]);

      const lineTotal = currency.subtract(currency.multiply(item.unitPrice, item.quantity), item.discountAmount);
      subtotal = currency.add(subtotal, lineTotal);
      costTotal = currency.add(costTotal, currency.multiply(costPrice, baseQty));
      const taxId = item.taxId || (defaultTax && defaultTax.id) || null;
      let itemTax = 0;
      if (taxId) {
        const taxResult = await client.query('SELECT id,rate FROM taxes WHERE id=$1 AND is_active=true',[taxId]);
        if (taxResult.rows.length) itemTax = currency.round2(lineTotal * Number(taxResult.rows[0].rate) / 100);
      }
      taxTotal = currency.add(taxTotal, itemTax);

      preparedItems.push({
        productId: product.id,
        unitId: item.unitId,
        quantity: item.quantity,
        unitName: unit ? unit.unit_name : product.base_unit,
        baseQuantity: baseQty,
        unitPrice: item.unitPrice,
        costPrice,
        totalPrice: lineTotal,
        discountAmount: item.discountAmount,
        taxId,
        taxAmount: itemTax,
        qtyBefore,
        qtyAfter
      });
    }

    const foreignTotalAmount = currency.add(currency.subtract(subtotal, discountAmount), taxTotal);
    const multiplier = currencyCode === 'YER' ? 1 : Number(exchangeRate);
    const totalAmount = currency.round2(foreignTotalAmount * multiplier);
    const totalPaid = currency.round2(currency.sum(payments.map((p) => p.amount)) * multiplier);

    // 6. التحقق من المدفوعات
    const hasCredit = payments.some((p) => p.isCredit);
    let customer = null;
    if (customerId) {
      const customerResult = await client.query(
        `SELECT c.*, cb.balance, cb.offline_reserved_amount FROM customers c
         LEFT JOIN customer_balances cb ON cb.customer_id = c.id
         WHERE c.id = $1 FOR UPDATE`,
        [customerId]
      );
      customer = customerResult.rows[0];
      if (!customer) throw new AppError('العميل غير موجود', 400);
    }

    const creditPaymentsResult = await client.query(
      `SELECT id, type FROM payment_methods WHERE id = ANY($1::uuid[])`,
      [payments.map((p) => p.paymentMethodId)]
    );
    const creditMethodIds = creditPaymentsResult.rows.filter((m) => m.type === 'credit').map((m) => m.id);
    const creditAmount = currency.sum(
      payments.filter((p) => creditMethodIds.includes(p.paymentMethodId)).map((p) => p.amount)
    ) * multiplier;

    if (creditAmount > 0) {
      if (!customer) throw new AppError('يجب اختيار عميل للبيع الآجل', 400);
      const currentBalance = currency.add(parseFloat(customer.balance || 0), parseFloat(customer.offline_reserved_amount || 0));
      const projectedBalance = currency.add(currentBalance, creditAmount);
      if (projectedBalance > parseFloat(customer.credit_limit)) {
        throw new AppError('تجاوز العميل الحد الائتماني المسموح', 400, 'CREDIT_LIMIT_EXCEEDED');
      }
    }

    // إجمالي المدفوعات (payments) يشمل بالفعل أي مبلغ آجل كبند دفع صريح ضمن الفاتورة،
    // لذا يُشترط دومًا أن يغطي مجموع كل وسائل الدفع مجتمعة (نقدي + آجل + غيرها) كامل الإجمالي (بند 7.1 خطوة 6)
    if (!currency.isGreaterOrEqual(totalPaid, totalAmount)) {
      throw new AppError('إجمالي المدفوعات أقل من إجمالي الفاتورة', 400);
    }

    const changeAmount = currency.subtract(totalPaid, totalAmount);

    // 7. إنشاء الفاتورة (رقم رسمي فقط إن كانت متصلة الآن - وإلا تبقى pending حتى المزامنة)
    let invoiceNumber = null;
    let syncStatus = 'synced';
    let serverSyncedAt = new Date();
    if (isOfflineCreated) {
      syncStatus = 'pending';
      serverSyncedAt = null;
    } else {
      const seqResult = await client.query("SELECT nextval('invoice_number_seq') AS seq");
      invoiceNumber = `INV-${new Date().getFullYear()}-${String(seqResult.rows[0].seq).padStart(8, '0')}`;
    }

    const invoiceResult = await client.query(
      `INSERT INTO invoices
        (invoice_number, terminal_id, local_sequence, sync_status, server_synced_at, invoice_type,
         customer_id, user_id, shift_id, currency_code, exchange_rate, foreign_total_amount, subtotal, discount_amount, tax_amount, total_amount,
         total_paid, change_amount, status, notes)
       VALUES ($1,$2,$3,$4,$5,'sale',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active',$18)
       RETURNING *`,
      [invoiceNumber, terminalId, localSequence, syncStatus, serverSyncedAt, customerId, userId, shiftId, currencyCode, multiplier, foreignTotalAmount, currency.round2(subtotal * multiplier), currency.round2(discountAmount * multiplier), currency.round2(taxTotal * multiplier), totalAmount, totalPaid, changeAmount, notes || null]
    );
    const invoice = invoiceResult.rows[0];

    // بنود الفاتورة + حركات المخزون
    for (const item of preparedItems) {
      await client.query(
        `INSERT INTO invoice_items
          (invoice_id, product_id, unit_id, quantity, unit_name, base_quantity, unit_price, cost_price, total_price, discount_amount, tax_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [invoice.id, item.productId, item.unitId, item.quantity, item.unitName, item.baseQuantity,
          currency.round2(item.unitPrice * multiplier), item.costPrice, currency.round2(item.totalPrice * multiplier), currency.round2(item.discountAmount * multiplier), item.taxId]
      );
      await client.query(
        `INSERT INTO inventory_transactions
          (product_id, transaction_type, base_quantity, reference_id, reference_type, quantity_before, quantity_after, user_id)
         VALUES ($1,'sale',$2,$3,'invoice',$4,$5,$6)`,
        [item.productId, -item.baseQuantity, invoice.id, item.qtyBefore, item.qtyAfter, userId]
      );
    }

    // المدفوعات
    for (const payment of payments) {
      await client.query(
        `INSERT INTO invoice_payments (invoice_id, payment_method_id, amount, reference_number)
         VALUES ($1,$2,$3,$4)`,
        [invoice.id, payment.paymentMethodId, payment.amount, payment.referenceNumber || null]
      );
    }

    // 9. تحديث الوردية
    const cashAmount = currency.subtract(totalAmount, creditAmount);
    await client.query(
      `UPDATE shifts SET total_sales = total_sales + $1, total_cash = total_cash + $2, total_credit = total_credit + $3
       WHERE id = $4`,
      [totalAmount, cashAmount, creditAmount, shiftId]
    );

    // تحديث رصيد العميل الآجل
    if (customer && creditAmount > 0) {
      await client.query(
        `INSERT INTO customer_balances (customer_id, balance, total_purchases, last_transaction_at)
         VALUES ($1, $2, $2, now())
         ON CONFLICT (customer_id) DO UPDATE SET
           balance = customer_balances.balance + $2,
           total_purchases = customer_balances.total_purchases + $2,
           last_transaction_at = now()`,
        [customerId, creditAmount]
      );
    }

    // 10. قيود محاسبية مبسّطة
    await client.query(
      `INSERT INTO ledger_entries (account_code, account_name, debit, credit, reference_id, reference_type, description, user_id)
       VALUES ('4000', 'إيرادات المبيعات', 0, $1, $2, 'invoice', 'فاتورة بيع', $3)`,
      [totalAmount, invoice.id, userId]
    );
    const journalLines = [];
    let nonCashPaid = 0;
    let cashPaymentIndex = -1;
    for (const payment of payments) {
      const pm = await client.query('SELECT type FROM payment_methods WHERE id=$1 AND is_active=true',[payment.paymentMethodId]);
      if (!pm.rows.length) throw new AppError('وسيلة الدفع غير موجودة',400);
      const type = pm.rows[0].type;
      if (type === 'cash') cashPaymentIndex = journalLines.length;
      else nonCashPaid += Number(payment.amount);
      journalLines.push({ code: paymentAccountCode(type), debit: currency.round2(Number(payment.amount) * multiplier) });
    }
    const excessChange = Math.max(0, Number(totalPaid) - Number(totalAmount));
    if (excessChange > 0) {
      if (cashPaymentIndex < 0) throw new AppError('المبلغ الزائد يجب أن يكون من النقدي',400);
      journalLines[cashPaymentIndex].debit = Number((journalLines[cashPaymentIndex].debit - excessChange).toFixed(2));
    }
    journalLines.push({ code: '4110', credit: currency.round2(currency.subtract(subtotal, discountAmount) * multiplier) });
    if (taxTotal > 0) journalLines.push({ code: '7110', credit: currency.round2(taxTotal * multiplier) });
    if (costTotal > 0) {
      journalLines.push({ code: '5110', debit: costTotal });
      journalLines.push({ code: '1140', credit: costTotal });
    }
    await postJournalEntry(client, { description: 'قيد فاتورة بيع', referenceId: invoice.id, referenceType: 'sale', userId, lines: journalLines });

    await client.query(
      `INSERT INTO audit_log (user_id, action_type, table_name, record_id, new_values, ip_address, device_info)
       VALUES ($1,'create_sale','invoices',$2,$3,$4,$5)`,
      [userId, invoice.id, JSON.stringify({ totalAmount, itemsCount: items.length }), ip, deviceInfo]
    );

    return invoice;
  });

  res.status(201).json({ invoice: result });
}));

/**
 * POST /api/pos/return - إنشاء فاتورة مرتجع (بند 7.2)
 */
const returnSchema = Joi.object({
  originalInvoiceId: Joi.string().uuid().required(),
  terminalId: Joi.string().max(50).required(),
  localSequence: Joi.number().integer().min(1).required(),
  shiftId: Joi.string().uuid().required(),
  items: Joi.array().items(Joi.object({
    invoiceItemId: Joi.string().uuid().required(),
    quantity: Joi.number().positive().required()
  })).min(1).required(),
  reason: Joi.string().max(500).allow('', null)
});

router.post('/return', validate(returnSchema), asyncHandler(async (req, res) => {
  const { originalInvoiceId, terminalId, localSequence, shiftId, items, reason } = req.body;
  const userId = req.user.id;

  const result = await db.withTransaction(async (client) => {
    const originalResult = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND invoice_type = 'sale' AND status = 'active' FOR UPDATE`,
      [originalInvoiceId]
    );
    if (originalResult.rows.length === 0) {
      throw new AppError('الفاتورة الأصلية غير موجودة أو غير قابلة للإرجاع', 400);
    }
    const original = originalResult.rows[0];

    let returnTotal = 0;
    let returnCostTotal = 0;
    const seqResult = await client.query("SELECT nextval('invoice_number_seq') AS seq");
    const invoiceNumber = `RET-${new Date().getFullYear()}-${String(seqResult.rows[0].seq).padStart(8, '0')}`;

    const returnInvoiceResult = await client.query(
      `INSERT INTO invoices
        (invoice_number, terminal_id, local_sequence, sync_status, server_synced_at, invoice_type,
         customer_id, user_id, shift_id, status, original_invoice_id, notes, subtotal, total_amount)
       VALUES ($1,$2,$3,'synced',now(),'return',$4,$5,$6,'active',$7,$8,0,0)
       RETURNING *`,
      [invoiceNumber, terminalId, localSequence, original.customer_id, userId, shiftId, originalInvoiceId, reason || null]
    );
    const returnInvoice = returnInvoiceResult.rows[0];

    for (const item of items) {
      const originalItemResult = await client.query(
        'SELECT * FROM invoice_items WHERE id = $1 AND invoice_id = $2',
        [item.invoiceItemId, originalInvoiceId]
      );
      const originalItem = originalItemResult.rows[0];
      if (!originalItem) throw new AppError('بند الفاتورة الأصلي غير موجود', 400);
      const priorReturnResult = await client.query(`SELECT COALESCE(SUM(ii.quantity),0) AS returned FROM invoice_items ii JOIN invoices ri ON ri.id=ii.invoice_id WHERE ri.invoice_type='return' AND ri.original_invoice_id=$1 AND ii.product_id=$2`,[originalInvoiceId,originalItem.product_id]);
      const alreadyReturned = Number(priorReturnResult.rows[0].returned||0);
      if (item.quantity + alreadyReturned > parseFloat(originalItem.quantity)) throw new AppError('إجمالي المرتجع يتجاوز الكمية المباعة سابقًا',400);

      const ratio = item.quantity / originalItem.quantity;
      const returnBaseQty = currency.round2(originalItem.base_quantity * ratio);
      const returnLineTotal = currency.round2(originalItem.total_price * ratio);
      returnTotal = currency.add(returnTotal, returnLineTotal);
      returnCostTotal = currency.add(returnCostTotal, currency.multiply(originalItem.cost_price, returnBaseQty));

      await client.query(
        `INSERT INTO invoice_items
          (invoice_id, product_id, unit_id, quantity, unit_name, base_quantity, unit_price, cost_price, total_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [returnInvoice.id, originalItem.product_id, originalItem.unit_id, item.quantity,
          originalItem.unit_name, returnBaseQty, originalItem.unit_price, originalItem.cost_price, returnLineTotal]
      );

      // استعادة الكمية للمخزون (دفعة جديدة عامة عند الإرجاع)
      const productResult = await client.query('SELECT base_quantity FROM products WHERE id = $1 FOR UPDATE', [originalItem.product_id]);
      const qtyBefore = parseFloat(productResult.rows[0].base_quantity);
      const qtyAfter = currency.round2(qtyBefore + returnBaseQty);
      await client.query('UPDATE products SET base_quantity = $1 WHERE id = $2', [qtyAfter, originalItem.product_id]);

      await client.query(
        `INSERT INTO inventory_transactions
          (product_id, transaction_type, base_quantity, reference_id, reference_type, quantity_before, quantity_after, user_id)
         VALUES ($1,'return_in',$2,$3,'invoice',$4,$5,$6)`,
        [originalItem.product_id, returnBaseQty, returnInvoice.id, qtyBefore, qtyAfter, userId]
      );
    }

    await client.query(
      'UPDATE invoices SET subtotal = $1, total_amount = $1, total_paid = $1 WHERE id = $2',
      [returnTotal, returnInvoice.id]
    );
    await client.query('UPDATE shifts SET total_returns = total_returns + $1 WHERE id = $2', [returnTotal, shiftId]);

    if (original.customer_id) {
      await client.query(
        `UPDATE customer_balances SET balance = balance - $1 WHERE customer_id = $2`,
        [returnTotal, original.customer_id]
      );
    }

    await postJournalEntry(client, { description: 'قيد مرتجع مبيعات', referenceId: returnInvoice.id, referenceType: 'return', userId,
      lines: [
        { code: '4110', debit: returnTotal },
        { code: original.customer_id ? '1130' : '1110', credit: returnTotal },
        ...(returnCostTotal > 0 ? [{ code: '1140', debit: returnCostTotal }, { code: '5110', credit: returnCostTotal }] : [])
      ] });

    return { ...returnInvoice, total_amount: returnTotal };
  });

  res.status(201).json({ invoice: result });
}));

/**
 * POST /api/pos/void/:id - إلغاء فاتورة (بند 7.3) - يتطلب صلاحية can_void ورمز أمان OTP
 */
const voidSchema = Joi.object({
  securityCode: Joi.string().required(),
  reason: Joi.string().min(3).max(500).required()
});

router.post('/void/:id', requirePermission('can_void'), validate(voidSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { securityCode, reason } = req.body;
  const userId = req.user.id;
  const ip = getClientIp(req);
  const deviceInfo = getDeviceInfo(req);

  const result = await db.withTransaction(async (client) => {
    // التحقق من رمز الأمان المُصدَر مسبقًا (يُخزَّن مؤقتًا - انظر endpoint توليد الرمز أدناه)
    const codeResult = await client.query(
      `SELECT * FROM notifications_log WHERE type = 'void_otp' AND recipient = $1 AND message = $2
       AND created_at > now() - (interval '1 second' * $3::numeric) ORDER BY created_at DESC LIMIT 1`,
      [String(userId), securityCode, parseInt(process.env.VOID_OTP_TTL_SECONDS || '90', 10)]
    );
    if (codeResult.rows.length === 0) {
      throw new AppError('رمز الأمان غير صالح أو منتهي الصلاحية', 401);
    }

    const invoiceResult = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [id]
    );
    if (invoiceResult.rows.length === 0) {
      throw new AppError('الفاتورة غير موجودة أو ملغاة مسبقًا', 400);
    }
    const invoice = invoiceResult.rows[0];

    const itemsResult = await client.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [id]);

    // استعادة المخزون
    for (const item of itemsResult.rows) {
      const productResult = await client.query('SELECT base_quantity FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
      const qtyBefore = parseFloat(productResult.rows[0].base_quantity);
      const qtyAfter = currency.round2(qtyBefore + parseFloat(item.base_quantity));
      await client.query('UPDATE products SET base_quantity = $1 WHERE id = $2', [qtyAfter, item.product_id]);
      await client.query(
        `INSERT INTO inventory_transactions
          (product_id, transaction_type, base_quantity, reference_id, reference_type, quantity_before, quantity_after, user_id)
         VALUES ($1,'void_restore',$2,$3,'invoice',$4,$5,$6)`,
        [item.product_id, item.base_quantity, id, qtyBefore, qtyAfter, userId]
      );
    }

    // عكس رصيد العميل إن كان الدفع آجلاً
    if (invoice.customer_id) {
      await client.query(
        'UPDATE customer_balances SET balance = balance - $1 WHERE customer_id = $2',
        [invoice.total_amount, invoice.customer_id]
      );
    }

    await client.query("UPDATE invoices SET status = 'void' WHERE id = $1", [id]);

    await client.query(
      `INSERT INTO voided_invoices (original_invoice_id, voided_by, security_code_used, reason, total_amount, original_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, userId, securityCode, reason, invoice.total_amount, JSON.stringify(invoice)]
    );

    const originalJournal = await client.query(`SELECT a.code,jl.debit,jl.credit FROM journal_entries je JOIN journal_entry_lines jl ON jl.journal_entry_id=je.id JOIN accounts a ON a.id=jl.account_id WHERE je.reference_id=$1 AND je.reference_type IN ('sale','invoice')`,[id]);
    if (originalJournal.rows.length) {
      await postJournalEntry(client, { description: 'عكس قيد فاتورة ملغاة', referenceId: id, referenceType: 'void', userId,
        lines: originalJournal.rows.map(line => ({ code: line.code, debit: Number(line.credit), credit: Number(line.debit) })) });
    }

    await client.query(
      `INSERT INTO audit_log (user_id, action_type, table_name, record_id, old_values, ip_address, device_info)
       VALUES ($1,'void_invoice','invoices',$2,$3,$4,$5)`,
      [userId, id, JSON.stringify(invoice), ip, deviceInfo]
    );

    return invoice;
  });

  res.json({ ok: true, invoice: result });
}));

/**
 * POST /api/pos/void-otp - توليد رمز أمان لعملية الإلغاء (صالح لمدة VOID_OTP_TTL_SECONDS)
 */
router.post('/void-otp', requirePermission('can_void'), asyncHandler(async (req, res) => {
  const code = generateSecurityCode(6);
  await db.query(
    `INSERT INTO notifications_log (type, recipient, message, status) VALUES ('void_otp', $1, $2, 'generated')`,
    [req.user.id, code]
  );
  res.json({ securityCode: code, ttlSeconds: parseInt(process.env.VOID_OTP_TTL_SECONDS || '90', 10) });
}));

/**
 * GET /api/pos/invoice/:id
 */
router.get('/invoice/:id', asyncHandler(async (req, res) => {
  const invoiceResult = await db.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (invoiceResult.rows.length === 0) throw new AppError('الفاتورة غير موجودة', 404);
  const itemsResult = await db.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
  const paymentsResult = await db.query('SELECT * FROM invoice_payments WHERE invoice_id = $1', [req.params.id]);
  res.json({ invoice: invoiceResult.rows[0], items: itemsResult.rows, payments: paymentsResult.rows });
}));

/**
 * GET /api/pos/invoices - قائمة مع pagination
 */
router.get('/invoices', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await db.query(
    `SELECT * FROM invoices ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const countResult = await db.query('SELECT COUNT(*) FROM invoices');
  res.json({
    invoices: result.rows,
    pagination: { page, limit, total: parseInt(countResult.rows[0].count, 10) }
  });
}));

/**
 * POST /api/pos/sync - استقبال دفعة فواتير من Terminal بعد انقطاع (بند 6.2)
 */
const syncBatchSchema = Joi.object({
  terminalId: Joi.string().max(50).required(),
  invoices: Joi.array().items(saleSchema).max(200).required()
});

router.post('/sync', validate(syncBatchSchema), asyncHandler(async (req, res) => {
  const { terminalId, invoices } = req.body;
  const results = [];
  const conflicts = [];

  for (const invoicePayload of invoices) {
    try {
      const existing = await db.query(
        'SELECT * FROM invoices WHERE terminal_id = $1 AND local_sequence = $2',
        [terminalId, invoicePayload.localSequence]
      );
      if (existing.rows.length > 0) {
        results.push({ localSequence: invoicePayload.localSequence, status: 'already_synced', invoiceId: existing.rows[0].id });
        continue;
      }
      const saleLayer = router.stack.find(layer => layer.route && layer.route.path === '/sale');
      if (!saleLayer) throw new AppError('مسار البيع الداخلي غير متاح للمزامنة',500);
      const internalReq = Object.create(req);
      internalReq.body = invoicePayload;
      internalReq.user = req.user;
      internalReq.cookies = req.cookies;
      const response = await new Promise((resolve,reject)=>{
        let settled=false;
        const internalRes={statusCode:200,status(code){this.statusCode=code;return this;},json(body){if(!settled){settled=true;resolve({status:this.statusCode,body});}},send(body){if(!settled){settled=true;resolve({status:this.statusCode,body});}}};
        let i=0;
        const next=(err)=>{if(err){if(!settled){settled=true;reject(err);}return;}const layer=saleLayer.route.stack[i++];if(!layer){if(!settled){settled=true;resolve({status:200,body:{}});}return;}try{Promise.resolve(layer.handle(internalReq,internalRes,next)).catch(reject);}catch(e){reject(e);}};
        next();
      });
      if(response.status>=400) throw new AppError(response.body?.error||'فشل تنفيذ فاتورة المزامنة',response.status);
      results.push({ localSequence: invoicePayload.localSequence, status: 'synced', invoiceId: response.body?.invoice?.id, invoiceNumber: response.body?.invoice?.invoice_number });
    } catch (err) {
      logger.error('فشل مزامنة فاتورة', { terminalId, localSequence: invoicePayload.localSequence, error: err.message });
      conflicts.push({ localSequence: invoicePayload.localSequence, error: err.message });
    }
  }

  res.json({ results, conflicts });
}));

module.exports = router;
