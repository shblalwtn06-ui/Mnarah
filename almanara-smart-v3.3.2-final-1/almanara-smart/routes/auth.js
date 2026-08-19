'use strict';

const express = require('express');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Joi = require('joi');
const { authenticator } = require('otplib');

const db = require('../config/db');
const logger = require('../utils/logger');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { asyncHandler, getClientIp, getDeviceInfo } = require('../utils/helpers');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: parseInt(process.env.ARGON2_MEMORY_COST || '19456', 10),
  timeCost: parseInt(process.env.ARGON2_TIME_COST || '2', 10),
  parallelism: parseInt(process.env.ARGON2_PARALLELISM || '1', 10)
};

const MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS || '5', 10);
const LOCK_MINUTES = parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10);

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict',
    domain: process.env.COOKIE_DOMAIN || undefined,
    maxAge: maxAgeMs
  };
}

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m'
  });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  });
}

function shapeUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    canVoid: user.can_void,
    canViewReports: user.can_view_reports,
    canManageInventory: user.can_manage_inventory
  };
}

const loginSchema = Joi.object({
  username: Joi.string().trim().min(3).max(50).required(),
  password: Joi.string().min(8).max(200).required(),
  totpCode: Joi.string().length(6).pattern(/^\d+$/).optional()
});

/**
 * POST /api/auth/login
 * Rate limit: 20/دقيقة لكل IP (middleware rateLimiter)
 * قفل الحساب بعد 5 محاولات فاشلة لمدة 15 دقيقة (بند 8)
 */
router.post('/login', loginLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const { username, password, totpCode } = req.body;
  const ip = getClientIp(req);
  const deviceInfo = getDeviceInfo(req);

  const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];

  // رسالة موحّدة عند عدم وجود المستخدم أو خطأ كلمة المرور - لمنع تعداد أسماء المستخدمين (user enumeration)
  const genericError = () => new AppError('اسم المستخدم أو كلمة المرور غير صحيحة', 401);

  if (!user || !user.is_active) {
    await logAudit(null, 'login_failed', ip, deviceInfo, { username, reason: 'not_found_or_inactive' });
    throw genericError();
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    throw new AppError(`الحساب مقفل مؤقتًا، حاول بعد ${minutesLeft} دقيقة`, 423);
  }

  const passwordValid = await argon2.verify(user.password_hash, password).catch(() => false);
  if (!passwordValid) {
    const attempts = user.failed_login_attempts + 1;
    const shouldLock = attempts >= MAX_ATTEMPTS;
    await db.query(
      `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
      [
        shouldLock ? 0 : attempts,
        shouldLock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null,
        user.id
      ]
    );
    await logAudit(user.id, 'login_failed', ip, deviceInfo, { attempts, locked: shouldLock });
    throw genericError();
  }

  // التحقق من 2FA إن كان مفعَّلًا لهذا المستخدم (إلزامي لدور admin وفق بند 8)
  if (user.two_factor_enabled) {
    if (!totpCode) {
      return res.status(200).json({ requiresTwoFactor: true });
    }
    const valid = authenticator.verify({ token: totpCode, secret: user.two_factor_secret });
    if (!valid) {
      await logAudit(user.id, 'login_2fa_failed', ip, deviceInfo, {});
      throw new AppError('رمز التحقق الثنائي غير صحيح', 401);
    }
  }

  // نجاح الدخول: إعادة تصفير عداد المحاولات الفاشلة
  await db.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshTokenHash, deviceInfo, ip, new Date(Date.now() + 7 * 24 * 3600 * 1000)]
  );

  res.cookie('access_token', accessToken, cookieOptions(15 * 60 * 1000));
  res.cookie('refresh_token', refreshToken, cookieOptions(7 * 24 * 3600 * 1000));

  await logAudit(user.id, 'login_success', ip, deviceInfo, {});

  res.json({
    user: shapeUser(user)
  });
}));

/**
 * POST /api/auth/refresh - تجديد الجلسة عبر refresh token
 */
router.post('/refresh', asyncHandler(async (req, res) => {
  const token = req.cookies && req.cookies.refresh_token;
  if (!token) throw new AppError('لا توجد جلسة صالحة للتجديد', 401);

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw new AppError('جلسة غير صالحة، الرجاء تسجيل الدخول مجددًا', 401);
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await db.query(
    `SELECT * FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [payload.sub, tokenHash]
  );
  if (result.rows.length === 0) {
    throw new AppError('انتهت صلاحية الجلسة، الرجاء تسجيل الدخول مجددًا', 401);
  }

  const userResult = await db.query('SELECT * FROM users WHERE id = $1 AND is_active = true', [payload.sub]);
  const user = userResult.rows[0];
  if (!user) throw new AppError('المستخدم غير موجود', 401);

  const accessToken = signAccessToken(user);
  res.cookie('access_token', accessToken, cookieOptions(15 * 60 * 1000));
  res.json({ ok: true });
}));

/**
 * POST /api/auth/logout - إبطال التوكنات
 */
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const token = req.cookies && req.cookies.refresh_token;
  if (token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND token_hash = $2',
      [req.user.id, tokenHash]
    );
  }
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  await logAudit(req.user.id, 'logout', getClientIp(req), getDeviceInfo(req), {});
  res.json({ ok: true });
}));

/**
 * GET /api/auth/me - بيانات المستخدم الحالي
 */
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({ user: shapeUser(req.user) });
}));

/**
 * POST /api/auth/2fa/setup - توليد سر TOTP جديد (إلزامي لاحقًا لدور admin)
 */
router.post('/2fa/setup', authenticate, asyncHandler(async (req, res) => {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(req.user.username, process.env.TWO_FACTOR_ISSUER || 'AlmanaraSmart', secret);
  await db.query('UPDATE users SET two_factor_secret = $1 WHERE id = $2', [secret, req.user.id]);
  res.json({ otpauthUrl: otpauth });
}));

/**
 * POST /api/auth/2fa/verify - تفعيل 2FA بعد التحقق من أول رمز
 */
const verify2faSchema = Joi.object({ totpCode: Joi.string().length(6).pattern(/^\d+$/).required() });
router.post('/2fa/verify', authenticate, validate(verify2faSchema), asyncHandler(async (req, res) => {
  const result = await db.query('SELECT two_factor_secret FROM users WHERE id = $1', [req.user.id]);
  const secret = result.rows[0] && result.rows[0].two_factor_secret;
  if (!secret) throw new AppError('لم يتم إعداد التوثيق الثنائي بعد', 400);

  const valid = authenticator.verify({ token: req.body.totpCode, secret });
  if (!valid) throw new AppError('رمز التحقق غير صحيح', 400);

  await db.query('UPDATE users SET two_factor_enabled = true WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

async function logAudit(userId, actionType, ip, deviceInfo, details) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, action_type, table_name, new_values, ip_address, device_info)
       VALUES ($1, $2, 'users', $3, $4, $5)`,
      [userId, actionType, JSON.stringify(details || {}), ip, deviceInfo]
    );
  } catch (err) {
    logger.error('فشل تسجيل audit_log', { error: err.message });
  }
}

module.exports = router;
