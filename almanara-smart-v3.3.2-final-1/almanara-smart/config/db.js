'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'almanara_smart',
  user: process.env.DB_USER || 'almanara_user',
  password: process.env.DB_PASSWORD || '',
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  // أخطاء غير متوقعة على عملاء خاملين في المجمع (pool) - لا تُسقط العملية بالكامل
  logger.error('خطأ غير متوقع في مجمع اتصالات قاعدة البيانات', { error: err.message });
});

/**
 * تنفيذ استعلام بسيط خارج معاملة صريحة
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 500) {
    logger.warn('استعلام بطيء', { text, duration });
  }
  return result;
}

/**
 * تنفيذ سلسلة عمليات ضمن معاملة واحدة ذرية (BEGIN...COMMIT/ROLLBACK)
 * وفق بند 7.1 و10.1: كل عملية بيع/مرتجع/إلغاء يجب أن تُنفَّذ ضمن معاملة واحدة
 * @param {(client: import('pg').PoolClient) => Promise<any>} callback
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('فشل التراجع (ROLLBACK) عن المعاملة', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * تنفيذ ملف schema.sql بالكامل - يُستخدم من أمر npm run migrate
 */
async function runSchema() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('تم تنفيذ schema.sql بنجاح');
  } finally {
    client.release();
  }
}

/**
 * فحص صحة الاتصال بقاعدة البيانات - يُستخدم في /api/health
 */
async function healthCheck() {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}

module.exports = { pool, query, withTransaction, runSchema, healthCheck };
