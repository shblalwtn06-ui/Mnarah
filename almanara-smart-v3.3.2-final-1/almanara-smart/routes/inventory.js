'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler, getClientIp, getDeviceInfo } = require('../utils/helpers');

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/inventory - حالة المخزون مع القيمة
 */
router.get('/', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT id, name, base_unit, base_quantity, reorder_point, base_cost,
            (base_quantity * base_cost) AS inventory_value
     FROM products WHERE is_active = true ORDER BY name ASC`
  );
  res.json({ inventory: result.rows });
}));

/**
 * GET /api/inventory/low-stock - تنبيهات المخزون المنخفض (لوحة التحكم 4.4)
 */
router.get('/low-stock', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT id, name, base_quantity, reorder_point FROM products
     WHERE is_active = true AND base_quantity <= reorder_point ORDER BY base_quantity ASC`
  );
  res.json({ products: result.rows });
}));

/**
 * GET /api/inventory/expiring-soon - منتجات قاربت انتهاء الصلاحية (بند 7.4 - قبل 40 يومًا)
 */
router.get('/expiring-soon', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days, 10) || 40;
  const result = await db.query(
    `SELECT ib.*, p.name AS product_name FROM inventory_batches ib
     JOIN products p ON p.id = ib.product_id
     WHERE ib.quantity_remaining > 0 AND ib.expiry_date IS NOT NULL
       AND ib.expiry_date <= (CURRENT_DATE + $1 * interval '1 day')
     ORDER BY ib.expiry_date ASC`,
    [days]
  );
  res.json({ batches: result.rows });
}));

/**
 * POST /api/inventory/adjust - تسوية جرد (فرق بين الفعلي والمسجَّل)
 */
const adjustSchema = Joi.object({
  productId: Joi.string().uuid().required(),
  newQuantity: Joi.number().min(0).required(),
  notes: Joi.string().max(500).allow('', null)
});
router.post('/adjust', requirePermission('can_manage_inventory'), validate(adjustSchema), asyncHandler(async (req, res) => {
  const { productId, newQuantity, notes } = req.body;
  const userId = req.user.id;

  const result = await db.withTransaction(async (client) => {
    const productResult = await client.query('SELECT base_quantity FROM products WHERE id = $1 FOR UPDATE', [productId]);
    if (productResult.rows.length === 0) throw new AppError('المنتج غير موجود', 404);
    const before = parseFloat(productResult.rows[0].base_quantity);
    const delta = newQuantity - before;

    await client.query('UPDATE products SET base_quantity = $1 WHERE id = $2', [newQuantity, productId]);
    await client.query(
      `INSERT INTO inventory_transactions
        (product_id, transaction_type, base_quantity, quantity_before, quantity_after, user_id, notes)
       VALUES ($1,'adjustment',$2,$3,$4,$5,$6)`,
      [productId, delta, before, newQuantity, userId, notes || 'تسوية جرد']
    );

    await client.query(
      `INSERT INTO audit_log (user_id, action_type, table_name, record_id, old_values, new_values, ip_address, device_info)
       VALUES ($1,'inventory_adjust','products',$2,$3,$4,$5,$6)`,
      [userId, productId, JSON.stringify({ quantity: before }), JSON.stringify({ quantity: newQuantity }),
        getClientIp(req), getDeviceInfo(req)]
    );

    return { before, after: newQuantity, delta };
  });

  res.json({ ok: true, adjustment: result });
}));

/**
 * GET /api/inventory/transactions/:productId - حركات المخزون لمنتج معيّن
 */
router.get('/transactions/:productId', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT * FROM inventory_transactions WHERE product_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [req.params.productId]
  );
  res.json({ transactions: result.rows });
}));

/**
 * GET /api/inventory/batches - عرض الدفعات
 */
router.get('/batches', asyncHandler(async (req, res) => {
  const productId = req.query.productId;
  const result = await db.query(
    productId
      ? 'SELECT * FROM inventory_batches WHERE product_id = $1 ORDER BY expiry_date ASC NULLS LAST'
      : 'SELECT * FROM inventory_batches WHERE quantity_remaining > 0 ORDER BY expiry_date ASC NULLS LAST LIMIT 200',
    productId ? [productId] : []
  );
  res.json({ batches: result.rows });
}));

module.exports = router;
