'use strict';

const express = require('express');
const os = require('os');

const db = require('../config/db');
const { asyncHandler } = require('../utils/helpers');

const router = express.Router();

/**
 * GET /api/health - فحص صحة الخادم (بند 10.5 من المواصفات: uptime, db connection, disk space)
 * لا يتطلب مصادقة عمدًا، ليُستخدم من أدوات المراقبة الخارجية.
 */
router.get('/', asyncHandler(async (req, res) => {
  let dbOk = false;
  let dbError = null;
  try {
    dbOk = await db.healthCheck();
  } catch (err) {
    dbError = err.message;
  }

  const health = {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    database: dbOk ? 'connected' : 'disconnected',
    databaseError: dbError,
    memory: {
      freeMB: Math.round(os.freemem() / 1024 / 1024),
      totalMB: Math.round(os.totalmem() / 1024 / 1024)
    },
    timestamp: new Date().toISOString()
  };

  res.status(dbOk ? 200 : 503).json(health);
}));

module.exports = router;
