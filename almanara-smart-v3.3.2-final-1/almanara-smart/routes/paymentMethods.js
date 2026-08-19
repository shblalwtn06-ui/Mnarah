'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler } = require('../utils/helpers');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM payment_methods WHERE is_active = true ORDER BY name ASC');
  res.json({ paymentMethods: result.rows });
}));

const pmSchema = Joi.object({
  name: Joi.string().min(1).max(50).required(),
  type: Joi.string().valid('cash', 'credit', 'wallet', 'bank', 'other').required(),
  requiresReference: Joi.boolean().default(false),
  icon: Joi.string().max(10).allow('', null)
});

router.post('/', requireRole('admin', 'manager'), validate(pmSchema), asyncHandler(async (req, res) => {
  const { name, type, requiresReference, icon } = req.body;
  const result = await db.query(
    `INSERT INTO payment_methods (name, type, requires_reference, icon) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, type, requiresReference, icon]
  );
  res.status(201).json({ paymentMethod: result.rows[0] });
}));

router.put('/:id', requireRole('admin', 'manager'), validate(pmSchema), asyncHandler(async (req, res) => {
  const { name, type, requiresReference, icon } = req.body;
  const result = await db.query(
    `UPDATE payment_methods SET name=$1, type=$2, requires_reference=$3, icon=$4 WHERE id=$5 RETURNING *`,
    [name, type, requiresReference, icon, req.params.id]
  );
  if (result.rows.length === 0) throw new AppError('وسيلة الدفع غير موجودة', 404);
  res.json({ paymentMethod: result.rows[0] });
}));

router.delete('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  await db.query('UPDATE payment_methods SET is_active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
