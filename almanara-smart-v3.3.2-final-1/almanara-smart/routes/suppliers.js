'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler, parsePagination } = require('../utils/helpers');
const { postJournalEntry } = require('../utils/accounting');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await db.query(
    'SELECT * FROM suppliers WHERE is_active = true ORDER BY name ASC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  res.json({ suppliers: result.rows, pagination: { page, limit } });
}));

router.get('/purchase-orders', requirePermission('can_manage_inventory'), asyncHandler(async (req,res)=>{ const r=await db.query(`SELECT po.*,s.name supplier_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id ORDER BY po.created_at DESC`); res.json({purchaseOrders:r.rows}); }));
router.get('/purchase-orders/:id', requirePermission('can_manage_inventory'), asyncHandler(async(req,res)=>{ const po=await db.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]); if(!po.rows.length) throw new AppError('أمر الشراء غير موجود',404); const items=await db.query('SELECT poi.*,p.name product_name FROM purchase_order_items poi JOIN products p ON p.id=poi.product_id WHERE purchase_order_id=$1',[req.params.id]); res.json({purchaseOrder:po.rows[0],items:items.rows}); }));
router.get('/:id', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) throw new AppError('المورد غير موجود', 404);
  res.json({ supplier: result.rows[0] });
}));

const supplierSchema = Joi.object({
  name: Joi.string().min(1).max(150).required(),
  phone: Joi.string().max(30).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().allow('', null)
});

router.post('/', requirePermission('can_manage_inventory'), validate(supplierSchema), asyncHandler(async (req, res) => {
  const { name, phone, email, address } = req.body;
  const result = await db.withTransaction(async client=>{const r=await client.query('INSERT INTO suppliers(name,phone,email,address) VALUES($1,$2,$3,$4) RETURNING *',[name,phone,email,address]);return r.rows[0];});
  res.status(201).json({ supplier: result });
}));

router.put('/:id', requirePermission('can_manage_inventory'), validate(supplierSchema), asyncHandler(async (req, res) => {
  const { name, phone, email, address } = req.body;
  const result = await db.query(
    'UPDATE suppliers SET name=$1, phone=$2, email=$3, address=$4 WHERE id=$5 RETURNING *',
    [name, phone, email, address, req.params.id]
  );
  if (result.rows.length === 0) throw new AppError('المورد غير موجود', 404);
  res.json({ supplier: result.rows[0] });
}));

router.delete('/:id', requirePermission('can_manage_inventory'), asyncHandler(async (req, res) => {
  await db.query('UPDATE suppliers SET is_active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/**
 * POST /api/suppliers/receive - استلام بضاعة: يُنشئ دفعة مخزون جديدة (بند 7.4)
 */
const receiveSchema = Joi.object({
  supplierId: Joi.string().uuid().required(),
  productId: Joi.string().uuid().required(),
  batchNumber: Joi.string().max(50).allow('', null),
  expiryDate: Joi.date().allow(null),
  purchasePrice: Joi.number().min(0).precision(2).required(),
  quantityReceived: Joi.number().positive().required(),
  taxId: Joi.string().uuid().allow(null)
});

router.post('/receive', requirePermission('can_manage_inventory'), validate(receiveSchema), asyncHandler(async (req, res) => {
  const { supplierId, productId, batchNumber, expiryDate, purchasePrice, quantityReceived, taxId } = req.body;
  const userId = req.user.id;

  const result = await db.withTransaction(async (client) => {
    const batchResult = await client.query(
      `INSERT INTO inventory_batches (product_id, supplier_id, batch_number, expiry_date, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [productId, supplierId, batchNumber, expiryDate, purchasePrice, quantityReceived]
    );

    const productResult = await client.query('SELECT base_quantity FROM products WHERE id = $1 FOR UPDATE', [productId]);
    if (productResult.rows.length === 0) throw new AppError('المنتج غير موجود', 404);
    const qtyBefore = parseFloat(productResult.rows[0].base_quantity);
    const qtyAfter = qtyBefore + quantityReceived;
    await client.query('UPDATE products SET base_quantity = $1, base_cost = $2 WHERE id = $3', [qtyAfter, purchasePrice, productId]);

    await client.query(
      `INSERT INTO inventory_transactions
        (product_id, transaction_type, base_quantity, reference_id, reference_type, quantity_before, quantity_after, user_id)
       VALUES ($1,'purchase',$2,$3,'inventory_batch',$4,$5,$6)`,
      [productId, quantityReceived, batchResult.rows[0].id, qtyBefore, qtyAfter, userId]
    );

    const baseCost = Number(purchasePrice) * Number(quantityReceived);
    let taxAmount = 0;
    if (taxId) { const tr=await client.query('SELECT rate FROM taxes WHERE id=$1 AND is_active=true',[taxId]); if(tr.rows.length) taxAmount=Number((baseCost*Number(tr.rows[0].rate)/100).toFixed(2)); }
    const totalCost = Number((baseCost + taxAmount).toFixed(2));
    // تحديث رصيد المورد (ذمم دائنة)

    await client.query('UPDATE suppliers SET balance = balance + $1 WHERE id = $2', [totalCost, supplierId]);

    await postJournalEntry(client, { description: 'استلام بضاعة من مورد', referenceId: batchResult.rows[0].id, referenceType: 'purchase', userId,
      lines: [{ code: '1140', debit: baseCost }, ...(taxAmount>0?[{code:'1150',debit:taxAmount}]:[]), { code: '2110', credit: totalCost }] });

    return batchResult.rows[0];
  });

  res.status(201).json({ batch: result });
}));

/**
 * POST /api/suppliers/purchase-orders - أمر شراء (تسجيل نية شراء دون التأثير على المخزون بعد)
 */
const poItemSchema = Joi.object({
  productId: Joi.string().uuid().required(), unitId: Joi.string().uuid().allow(null), quantity: Joi.number().positive().required(), unitPrice: Joi.number().min(0).precision(2).required(), taxId: Joi.string().uuid().allow(null)
});
const poSchema = Joi.object({ supplierId: Joi.string().uuid().required(), notes: Joi.string().allow('', null), items: Joi.array().items(poItemSchema).min(1).required() });
router.get('/purchase-orders', requirePermission('can_manage_inventory'), asyncHandler(async (req,res)=>{
  const r=await db.query(`SELECT po.*,s.name supplier_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id ORDER BY po.created_at DESC`); res.json({purchaseOrders:r.rows});
}));
router.get('/purchase-orders/:id', requirePermission('can_manage_inventory'), asyncHandler(async(req,res)=>{
  const po=await db.query('SELECT * FROM purchase_orders WHERE id=$1',[req.params.id]); if(!po.rows.length) throw new AppError('أمر الشراء غير موجود',404);
  const items=await db.query('SELECT poi.*,p.name product_name FROM purchase_order_items poi JOIN products p ON p.id=poi.product_id WHERE purchase_order_id=$1',[req.params.id]); res.json({purchaseOrder:po.rows[0],items:items.rows});
}));
router.post('/purchase-orders/:id/receive', requirePermission('can_manage_inventory'), asyncHandler(async(req,res)=>{
  const result=await db.withTransaction(async client=>{
    const po=await client.query(`SELECT * FROM purchase_orders WHERE id=$1 AND status IN ('ordered','partially_received') FOR UPDATE`,[req.params.id]); if(!po.rows.length) throw new AppError('أمر الشراء غير موجود أو غير قابل للاستلام',400);
    const items=await client.query('SELECT * FROM purchase_order_items WHERE purchase_order_id=$1',[req.params.id]); let total=0,baseTotal=0,taxTotal=0;
    for(const item of items.rows){const p=await client.query('SELECT base_quantity FROM products WHERE id=$1 FOR UPDATE',[item.product_id]);if(!p.rows.length)throw new AppError('منتج في أمر الشراء غير موجود',400);const before=Number(p.rows[0].base_quantity),after=before+Number(item.quantity);const batch=await client.query(`INSERT INTO inventory_batches(product_id,supplier_id,purchase_price,quantity_received,quantity_remaining) VALUES($1,$2,$3,$4,$4) RETURNING id`,[item.product_id,po.rows[0].supplier_id,item.unit_price,item.quantity]);await client.query('UPDATE products SET base_quantity=$1,base_cost=$2 WHERE id=$3',[after,item.unit_price,item.product_id]);await client.query(`INSERT INTO inventory_transactions(product_id,transaction_type,base_quantity,reference_id,reference_type,quantity_before,quantity_after,user_id) VALUES($1,'purchase',$2,$3,'purchase_order',$4,$5,$6)`,[item.product_id,item.quantity,batch.rows[0].id,before,after,req.user.id]);total+=Number(item.total_amount); baseTotal+=Number(item.quantity)*Number(item.unit_price); taxTotal+=Number(item.tax_amount||0);}
    await client.query(`UPDATE suppliers SET balance=balance+$1 WHERE id=$2`,[total,po.rows[0].supplier_id]);
    await client.query(`UPDATE purchase_orders SET status='received' WHERE id=$1`,[req.params.id]);
    await postJournalEntry(client,{description:'استلام أمر شراء',referenceId:req.params.id,referenceType:'purchase_order',userId:req.user.id,lines:[{code:'1140',debit:baseTotal},...(taxTotal>0?[{code:'1150',debit:taxTotal}]:[]),{code:'2110',credit:total}]});
    return {purchaseOrderId:req.params.id,total};
  }); res.json(result);
}));

router.post('/purchase-orders', requirePermission('can_manage_inventory'), validate(poSchema), asyncHandler(async (req, res) => {
  const result=await db.withTransaction(async client=>{
    const number=`PO-${new Date().getFullYear()}-${String(Date.now()).slice(-8)}`;
    let subtotal=0,taxTotal=0;
    const po=await client.query(`INSERT INTO purchase_orders(order_number,supplier_id,user_id,status,notes) VALUES($1,$2,$3,'ordered',$4) RETURNING *`,[number,req.body.supplierId,req.user.id,req.body.notes||null]);
    for(const item of req.body.items){
      const line=Number((item.quantity*item.unitPrice).toFixed(2)); let tax=0;
      if(item.taxId){const tr=await client.query('SELECT rate FROM taxes WHERE id=$1 AND is_active=true',[item.taxId]); if(tr.rows.length) tax=Number((line*Number(tr.rows[0].rate)/100).toFixed(2));}
      subtotal+=line; taxTotal+=tax;
      await client.query(`INSERT INTO purchase_order_items(purchase_order_id,product_id,unit_id,quantity,unit_price,tax_id,tax_amount,total_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[po.rows[0].id,item.productId,item.unitId||null,item.quantity,item.unitPrice,item.taxId||null,tax,line+tax]);
    }
    const updated=await client.query(`UPDATE purchase_orders SET subtotal=$1,tax_amount=$2,total_amount=$3 WHERE id=$4 RETURNING *`,[subtotal,taxTotal,subtotal+taxTotal,po.rows[0].id]);
    return updated.rows[0];
  });
  res.status(201).json({purchaseOrder:result});
}));

module.exports = router;
