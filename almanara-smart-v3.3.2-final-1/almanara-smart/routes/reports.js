'use strict';

const express = require('express');
const db = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
async function displayRate(target){ if(!target||target==='YER') return 1; const r=await db.query(`SELECT rate FROM exchange_rates WHERE from_currency=$1 AND to_currency='YER' ORDER BY effective_at DESC LIMIT 1`,[target]); return r.rows[0]?1/Number(r.rows[0].rate):1; }

const router = express.Router();
router.use(authenticate, requirePermission('can_view_reports'));

/** GET /api/reports/sales - تقرير المبيعات (فلترة بفترة زمنية اختيارية) */
router.get('/sales', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const result = await db.query(
    `SELECT date_trunc('day', created_at) AS day, COUNT(*) AS invoices_count, SUM(total_amount) AS total
     FROM invoices
     WHERE invoice_type = 'sale' AND status = 'active'
       AND ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at <= $2)
     GROUP BY day ORDER BY day DESC`,
    [from || null, to || null]
  );
  const rate=await displayRate(req.query.currency); const display=result.rows.map(r=>({...r,total:(Number(r.total)*rate).toFixed(2)}));
  const total=display.reduce((sum,r)=>sum+Number(r.total||0),0);
  res.json({ currency:req.query.currency||'YER', report: display, totalSales: total.toFixed(2), totalInvoices: result.rows.reduce((sum,r)=>sum+Number(r.invoices_count||0),0) });
}));

/** GET /api/reports/profit - الأرباح وتكلفة البضاعة المباعة (COGS) */
router.get('/profit', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const result = await db.query(
    `SELECT date_trunc('day', i.created_at) AS day,
            SUM(ii.total_price) AS revenue,
            SUM(ii.cost_price * ii.base_quantity) AS cogs,
            SUM(ii.total_price) - SUM(ii.cost_price * ii.base_quantity) AS gross_profit
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     WHERE i.invoice_type = 'sale' AND i.status = 'active'
       AND ($1::timestamptz IS NULL OR i.created_at >= $1)
       AND ($2::timestamptz IS NULL OR i.created_at <= $2)
     GROUP BY day ORDER BY day DESC`,
    [from || null, to || null]
  );
  const rate=await displayRate(req.query.currency); const display=result.rows.map(r=>({...r,revenue:(Number(r.revenue)*rate).toFixed(2),cogs:(Number(r.cogs)*rate).toFixed(2),gross_profit:(Number(r.gross_profit)*rate).toFixed(2)}));
  const revenue=display.reduce((sum,r)=>sum+Number(r.revenue||0),0); const cogs=display.reduce((sum,r)=>sum+Number(r.cogs||0),0);
  res.json({ currency:req.query.currency||'YER', report: display, revenue: revenue.toFixed(2), cogs: cogs.toFixed(2), grossProfit: (revenue-cogs).toFixed(2) });
}));

/** GET /api/reports/inventory - قيمة المخزون الحالية */
router.get('/inventory', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT SUM(base_quantity * base_cost) AS total_value, COUNT(*) AS products_count
     FROM products WHERE is_active = true`
  );
  const rate=await displayRate(req.query.currency); const row=result.rows[0]||{}; if(row.total_value!==null) row.total_value=(Number(row.total_value)*rate).toFixed(2); res.json({ currency:req.query.currency||'YER', report: row });
}));

/** GET /api/reports/customer-debts - ديون العملاء (لدعم Drill-down بند 4.4) */
router.get('/customer-debts', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT c.id, c.name, c.phone, cb.balance, c.credit_limit
     FROM customers c JOIN customer_balances cb ON cb.customer_id = c.id
     WHERE cb.balance > 0 ORDER BY cb.balance DESC`
  );
  const rate=await displayRate(req.query.currency); const display=result.rows.map(r=>({...r,balance:(Number(r.balance)*rate).toFixed(2),credit_limit:(Number(r.credit_limit)*rate).toFixed(2)})); res.json({currency:req.query.currency||'YER',report:display});
}));

/** GET /api/reports/supplier-debts - ديون الموردين */
router.get('/supplier-debts', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT id, name, phone, balance FROM suppliers WHERE balance > 0 ORDER BY balance DESC`
  );
  const rate=await displayRate(req.query.currency); const display=result.rows.map(r=>({...r,balance:(Number(r.balance)*rate).toFixed(2)})); res.json({currency:req.query.currency||'YER',report:display});
}));

/** GET /api/reports/shift-summary/:shiftId - ملخص وردية */
router.get('/shift-summary/:shiftId', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM shifts WHERE id = $1', [req.params.shiftId]);
  const drawer = await db.query(`SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE 0 END),0) withdrawals, COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END),0) deposits FROM cash_drawer_transactions WHERE shift_id=$1`,[req.params.shiftId]);
  res.json({ shift: result.rows[0] || null, drawer: drawer.rows[0] });
}));

/** GET /api/reports/payment-methods-summary - توزيع المدفوعات */
router.get('/payment-methods-summary', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT pm.name, pm.icon, SUM(ip.amount) AS total
     FROM invoice_payments ip
     JOIN payment_methods pm ON pm.id = ip.payment_method_id
     JOIN invoices i ON i.id = ip.invoice_id
     WHERE i.status = 'active'
     GROUP BY pm.name, pm.icon ORDER BY total DESC`
  );
  const rate=await displayRate(req.query.currency); const display=result.rows.map(r=>({...r,total:(Number(r.total)*rate).toFixed(2)})); res.json({currency:req.query.currency||'YER',report:display});
}));

/** GET /api/reports/top-products - أعلى المنتجات مبيعًا (للرسم الشريطي في Dashboard) */
router.get('/top-products', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT p.name, SUM(ii.quantity) AS qty, SUM(ii.total_price) AS revenue
     FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN products p ON p.id = ii.product_id
     WHERE i.status = 'active' AND i.invoice_type = 'sale'
     GROUP BY p.name ORDER BY revenue DESC LIMIT 10`
  );
  const rate=await displayRate(req.query.currency); const display=result.rows.map(r=>({...r,revenue:(Number(r.revenue)*rate).toFixed(2)})); res.json({currency:req.query.currency||'YER',report:display});
}));

/** GET /api/reports/sales-by-category - توزيع المبيعات حسب التصنيف (رسم دائري) */
router.get('/sales-by-category', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT COALESCE(c.name, 'غير مصنَّف') AS category, SUM(ii.total_price) AS total
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     JOIN products p ON p.id = ii.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE i.status = 'active' AND i.invoice_type = 'sale'
     GROUP BY c.name ORDER BY total DESC`
  );
  const rate=await displayRate(req.query.currency); const display=result.rows.map(r=>({...r,total:(Number(r.total)*rate).toFixed(2)})); res.json({currency:req.query.currency||'YER',report:display});
}));

module.exports = router;
