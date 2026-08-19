'use strict';

const logger = require('../utils/logger');

/** خطأ تشغيلي معروف يمكن عرض رسالته مباشرة للمستخدم بأمان */
class AppError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'المسار المطلوب غير موجود' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;

  logger.error('خطأ في الطلب', {
    message: err.message,
    path: req.originalUrl,
    method: req.method,
    statusCode,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
  });

  // لا نُسرّب تفاصيل الأخطاء الداخلية غير المتوقعة للمستخدم في الإنتاج
  const message = err.isOperational || process.env.NODE_ENV !== 'production'
    ? err.message
    : 'حدث خطأ غير متوقع، الرجاء المحاولة لاحقًا';

  res.status(statusCode).json({
    error: message,
    code: err.code
  });
}

module.exports = { AppError, notFoundHandler, errorHandler };
