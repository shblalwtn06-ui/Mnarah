'use strict';

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = process.env.LOG_DIR || './logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// حقول حساسة يجب عدم تسجيلها أبدًا في ملفات اللوق (بند 8 من المواصفات)
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'token', 'accessToken', 'refreshToken',
  'jwt', 'authorization', 'cookie', 'two_factor_secret', 'security_code',
  'card_number', 'cvv'
]);

function redact(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const redactFormat = winston.format((info) => {
  const { message, level, timestamp, stack, ...meta } = info;
  const safeMeta = redact(meta);
  return { ...info, ...safeMeta };
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    redactFormat(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

module.exports = logger;
