'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler, parsePagination, getClientIp, getDeviceInfo } = require('../utils/helpers');
const { postJournalEntry, paymentAccountCode } = require('../utils/accounting');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const search = req.query.search ? `%${req.query.search}%` : null;
  const result = await db.query(
    `SELECT c.*, COALESCE(cb.balance, 0) AS balance
     FROM customers c LEFT JOIN customer_balances cb ON cb.customer_id = c.id
     WHERE c.is_active = true AND ($3::text IS NULL OR c.name ILIKE $3 OR c.phone ILIKE $3)
     ORDER BY c.name ASC LIMIT $1 OFFSET $2`,
    [limit, offset, search]
  );
  res.json({ customers: result.rows, pagination: { page, limit } });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT c.*, COALESCE(cb.balance, 0) AS balance, cb.total_purchases, cb.total_payments
     FROM customers c LEFT JOIN customer_balances cb ON cb.customer_id = c.id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (result.rows.length === 0) throw new AppError('العميل غير موجود', 404);
  res.json({ customer: result.rows[0] });
}));

const customerSchema = Joi.object({
  name: Joi.string().min(1).max(150).required(),
  phone: Joi.string().max(30).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().allow('', null),
  customerType: Joi.string().valid('retail', 'wholesale', 'both').default('retail'),
  creditLimit: Joi.number().min(0).default(0)
});

router.post('/', validate(customerSchema), asyncHandler(async (req, res) => {
  const { name, phone, email, address, customerType, creditLimit } = req.body;
  const result = await db.withTransaction(async client=>{
    const customer=await client.query(`INSERT INTO customers(name,phone,email,address,customer_type,credit_limit) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[name,phone,email,address,customerType,creditLimit]);
    await client.query('INSERT INTO customer_balances(customer_id,balance) VALUES($1,0)',[customer.rows[0].id]);
    return customer.rows[0];
  });
  res.status(201).json({ customer: result });
}));

router.put('/:id', validate(customerSchema), asyncHandler(async (req, res) => {
  const { name, phone, email, address, customerType, creditLimit } = req.body;
  const result = await db.query(
    `UPDATE customers SET name=$1, phone=$2, email=$3, address=$4, customer_type=$5, credit_limit=$6
     WHERE id=$7 RETURNING *`,
    [name, phone, email, address, customerType, creditLimit, req.params.id]
  );
  if (result.rows.length === 0) throw new AppError('العميل غير موجود', 404);
  res.json({ customer: result.rows[0] });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await db.query('UPDATE customers SET is_active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/**
 * POST /api/customers/:id/payment - تسجيل دفعة من العميل (تسديد دين)
 */
const paymentSchema = Joi.object({
  amount: Joi.number().positive().required(),
  paymentMethodId: Joi.string().uuid().required(),
  notes: Joi.string().allow('', null)
});
router.post('/:id/payment', validate(paymentSchema), asyncHandler(async (req, res) => {
  const { amount, notes, paymentMethodId } = req.body;
  const userId = req.user.id;

  const result = await db.withTransaction(async (client) => {
    const balanceResult = await client.query(
      'SELECT * FROM customer_balances WHERE customer_id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (balanceResult.rows.length === 0) throw new AppError('العميل غير موجود', 404);

    const methodResult = await client.query('SELECT id, name FROM payment_methods WHERE id = $1 AND is_active = true', [paymentMethodId]);
    if (methodResult.rows.length === 0) throw new AppError('وسيلة الدفع غير موجودة', 400);

    await client.query(
      `UPDATE customer_balances SET balance = balance - $1, total_payments = total_payments + $1, last_transaction_at = now()
       WHERE customer_id = $2`,
      [amount, req.params.id]
    );

    // قيد محاسبي: تسديد دين عميل يُخفِّض حساب الذمم المدينة ويزيد النقدية/وسيلة الدفع المستخدمة
    await client.query(
      `INSERT INTO ledger_entries (account_code, account_name, debit, credit, reference_id, reference_type, description, user_id)
       VALUES ('1000', $1, $2, 0, $3, 'customer_payment', $4, $5)`,
      [`تحصيل عبر ${methodResult.rows[0].name}`, amount, req.params.id, notes || 'تسديد دين عميل', userId]
    );
    const methodTypeResult = await client.query('SELECT type FROM payment_methods WHERE id=$1',[paymentMethodId]);
    if (methodTypeResult.rows[0]?.type === 'credit') throw new AppError('لا يمكن استخدام وسيلة آجل لتسديد دين العميل',400);
    await postJournalEntry(client, { description: notes || 'تسديد دين عميل', referenceId: req.params.id, referenceType: 'customer_payment', userId,
      lines: [{ code: paymentAccountCode(methodTypeResult.rows[0].type), debit: amount }, { code: '1130', credit: amount }] });

    await client.query(
      `INSERT INTO audit_log (user_id, action_type, table_name, record_id, new_values, ip_address, device_info)
       VALUES ($1,'customer_payment','customer_balances',$2,$3,$4,$5)`,
      [userId, req.params.id, JSON.stringify({ amount, notes, paymentMethodId }), getClientIp(req), getDeviceInfo(req)]
    );

    return { amount, paymentMethodId };
  });

  res.json({ ok: true, payment: result });
}));

module.exports = router;
