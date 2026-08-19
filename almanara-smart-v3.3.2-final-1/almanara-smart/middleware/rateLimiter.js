'use strict';

const rateLimit = require('express-rate-limit');

/**
 * حدود صريحة بالأرقام وفق بند 8 من المواصفات (وليست وصفًا عامًا فقط):
 * - تسجيل الدخول: 20 محاولة/دقيقة لكل IP
 * - نقطة البيع: 100 طلب/دقيقة لكل مستخدم
 * - عام: 300 طلب/دقيقة
 */

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN_PER_MINUTE || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات تسجيل دخول كثيرة جدًا، الرجاء المحاولة بعد دقيقة' }
});

const posLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_POS_PER_MINUTE || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? req.user.id : req.ip),
  message: { error: 'تجاوزت الحد المسموح من العمليات، الرجاء الانتظار قليلاً' }
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GENERAL_PER_MINUTE || '300', 10),
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { loginLimiter, posLimiter, generalLimiter };
