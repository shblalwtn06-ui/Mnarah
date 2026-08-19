'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const logger = require('./utils/logger');
const { generalLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const posRoutes = require('./routes/pos');
const productsRoutes = require('./routes/products');
const customersRoutes = require('./routes/customers');
const suppliersRoutes = require('./routes/suppliers');
const inventoryRoutes = require('./routes/inventory');
const reportsRoutes = require('./routes/reports');
const shiftsRoutes = require('./routes/shifts');
const paymentMethodsRoutes = require('./routes/paymentMethods');
const whatsappRoutes = require('./routes/whatsapp');
const healthRoutes = require('./routes/health');
const accountingRoutes = require('./routes/accounting');

if (process.env.NODE_ENV === 'production') {
  for (const key of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET']) {
    if (!process.env[key] || process.env[key].length < 64 || process.env[key].startsWith('change')) throw new Error(`${key} must be a strong production secret`);
  }
}

const app = express();

// خلف بروكسي عكسي محتمل (Nginx) - ضروري لقراءة X-Forwarded-For بشكل صحيح
app.set('trust proxy', 1);

// ==========================================================
// أمان الرؤوس (Headers) - بند 8: CSP صارم بدون unsafe-inline
// ==========================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
      styleSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : true,
  credentials: true
}));

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(generalLimiter);

// تسجيل موجز لكل طلب (بدون بيانات حساسة - راجع logger.js للفلترة)
app.use((req, res, next) => {
  logger.info('طلب وارد', { method: req.method, path: req.path });
  next();
});

// ==========================================================
// الملفات الثابتة (الواجهة الأمامية)
// ==========================================================
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      // منع تخزين Service Worker نفسه لضمان استلام التحديثات فورًا
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ==========================================================
// مسارات الـ API
// ==========================================================
app.use('/api/auth', authRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use('/api/payment-methods', paymentMethodsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/accounting', accountingRoutes);

// أي مسار غير API يُعاد توجيهه لتطبيق الصفحة الواحدة (SPA)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', notFoundHandler);
app.use(errorHandler);

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  logger.info(`خادم المنارة الذكي v3.3 يعمل على المنفذ ${PORT}`, { env: process.env.NODE_ENV || 'development' });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', { reason: reason && reason.message });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = app;
