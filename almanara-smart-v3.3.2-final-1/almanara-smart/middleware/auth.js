'use strict';

const jwt = require('jsonwebtoken');
const db = require('../config/db');
const logger = require('../utils/logger');

/**
 * التحقق من JWT المخزَّن في httpOnly cookie (بند 8: JWT httpOnly + Secure + SameSite=Strict)
 */
async function authenticate(req, res, next) {
  try {
    const token = req.cookies && req.cookies.access_token;
    if (!token) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'انتهت صلاحية الجلسة', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'جلسة غير صالحة' });
    }

    const result = await db.query(
      `SELECT id, username, full_name, role, is_active, can_void, can_view_reports, can_manage_inventory
       FROM users WHERE id = $1`,
      [payload.sub]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'المستخدم غير موجود أو معطَّل' });
    }

    req.user = user;
    next();
  } catch (err) {
    logger.error('خطأ أثناء التحقق من المصادقة', { error: err.message });
    res.status(500).json({ error: 'خطأ داخلي في الخادم' });
  }
}

/**
 * فرض دور محدد (RBAC) - يدعم Role-based UI/API معًا
 * @param {...string} allowedRoles
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'ليست لديك صلاحية للوصول لهذا المورد' });
    }
    next();
  };
}

/** فرض صلاحية دقيقة (permission flag) بدل الدور الكامل */
function requirePermission(flag) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    if (req.user.role === 'admin') return next(); // admin يملك كل الصلاحيات دومًا
    if (!req.user[flag]) {
      return res.status(403).json({ error: 'ليست لديك الصلاحية المطلوبة لهذه العملية' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requirePermission };
