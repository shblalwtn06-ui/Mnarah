'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler, parsePagination } = require('../utils/helpers');

const router = express.Router();
router.use(authenticate);

const openSchema = Joi.object({ openingBalance: Joi.number().min(0).required() });

/** POST /api/shifts/open - فتح وردية جديدة (يمنع فتح أكثر من وردية مفتوحة لنفس المستخدم) */
router.post('/open', validate(openSchema), asyncHandler(async (req, res) => {
  const existing = await db.query(
    `SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'`,
    [req.user.id]
  );
  if (existing.rows.length > 0) {
    throw new AppError('يوجد لديك وردية مفتوحة بالفعل', 400);
  }
  const result = await db.query(
    `INSERT INTO shifts (user_id, opening_balance) VALUES ($1,$2) RETURNING *`,
    [req.user.id, req.body.openingBalance]
  );
  res.status(201).json({ shift: result.rows[0] });
}));

const closeSchema = Joi.object({ closingBalance: Joi.number().min(0).required() });

/** POST /api/shifts/:id/close - إغلاق وردية */
router.post('/:id/close', validate(closeSchema), asyncHandler(async (req, res) => {
  const result = await db.query(
    `UPDATE shifts SET status = 'closed', ended_at = now(), closing_balance = $1
     WHERE id = $2 AND user_id = $3 AND status = 'open' RETURNING *`,
    [req.body.closingBalance, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) throw new AppError('الوردية غير موجودة أو مغلقة مسبقًا', 400);
  res.json({ shift: result.rows[0] });
}));

/** GET /api/shifts/current - الوردية المفتوحة الحالية للمستخدم */
router.get('/current', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT * FROM shifts WHERE user_id = $1 AND status = 'open' LIMIT 1`,
    [req.user.id]
  );
  res.json({ shift: result.rows[0] || null });
}));

/** GET /api/shifts - قائمة الورديات */
router.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await db.query(
    `SELECT s.*, u.full_name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id
     ORDER BY s.started_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json({ shifts: result.rows, pagination: { page, limit } });
}));

module.exports = router;
