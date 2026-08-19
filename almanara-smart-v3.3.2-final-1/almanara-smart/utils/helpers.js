'use strict';

const crypto = require('crypto');

/** توليد رمز أمان (OTP) رقمي قصير لعمليات الإلغاء - بند 7.3 (صالح 60-120 ثانية) */
function generateSecurityCode(length = 6) {
  const digits = '0123456789';
  let code = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += digits[bytes[i] % digits.length];
  }
  return code;
}

/** استخراج عنوان IP الحقيقي مع مراعاة وجود بروكسي عكسي أمامي */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || req.ip || 'unknown';
}

/** استخراج معلومات موجزة عن الجهاز/المتصفح لأغراض audit_log و refresh_tokens */
function getDeviceInfo(req) {
  return (req.headers['user-agent'] || 'unknown').slice(0, 255);
}

/** توليد مفتاح idempotency افتراضي إن لم يُرسله العميل (لا يُنصح الاعتماد عليه بديلاً دائمًا) */
function generateIdempotencyKey() {
  return crypto.randomUUID();
}

/** ترقيم صفحات موحّد للاستعلامات */
function parsePagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** يلتف حول دوال async في الراوتات لتمرير الأخطاء تلقائيًا إلى errorHandler */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = {
  generateSecurityCode,
  getClientIp,
  getDeviceInfo,
  generateIdempotencyKey,
  parsePagination,
  asyncHandler
};
