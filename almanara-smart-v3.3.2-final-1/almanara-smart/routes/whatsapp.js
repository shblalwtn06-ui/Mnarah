'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const logger = require('../utils/logger');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler } = require('../utils/helpers');

const router = express.Router();
router.use(authenticate);

/**
 * الاعتماد حصريًا على WhatsApp Business API الرسمي في بيئة الإنتاج (بند 2.3 من المواصفات v3.2)
 * لا تُستخدم مكتبات غير رسمية (كـ whatsapp-web.js) لتفادي مخالفة شروط واتساب وحظر الحساب.
 */
async function sendViaOfficialApi(to, message) {
  const apiUrl = process.env.WHATSAPP_API_URL;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!apiUrl || !phoneNumberId || !accessToken) {
    throw new AppError('لم يتم إعداد بيانات اعتماد WhatsApp Business API - راجع ملف .env', 500, 'WHATSAPP_NOT_CONFIGURED');
  }

  const response = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(`فشل إرسال رسالة واتساب: ${data.error ? data.error.message : response.statusText}`, 502);
  }
  return data;
}

const sendSchema = Joi.object({
  to: Joi.string().pattern(/^\+?[0-9]{8,15}$/).required(),
  message: Joi.string().min(1).max(1000).required(),
  invoiceId: Joi.string().uuid().allow(null)
});

/** POST /api/whatsapp/send */
router.post('/send', validate(sendSchema), asyncHandler(async (req, res) => {
  const { to, message, invoiceId } = req.body;

  const logResult = await db.query(
    `INSERT INTO notifications_log (type, recipient, message, status) VALUES ('whatsapp',$1,$2,'pending') RETURNING id`,
    [to, message]
  );
  const logId = logResult.rows[0].id;

  try {
    await sendViaOfficialApi(to, message);
    await db.query(`UPDATE notifications_log SET status = 'sent', sent_at = now() WHERE id = $1`, [logId]);
    res.json({ ok: true });
  } catch (err) {
    logger.error('فشل إرسال واتساب', { error: err.message, invoiceId });
    await db.query(`UPDATE notifications_log SET status = 'failed', error = $1 WHERE id = $2`, [err.message, logId]);
    throw err;
  }
}));

/** GET /api/whatsapp/status - حالة الاتصال بواجهة واتساب */
router.get('/status', asyncHandler(async (req, res) => {
  const configured = Boolean(
    process.env.WHATSAPP_API_URL && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN
  );
  res.json({ configured });
}));

module.exports = router;
