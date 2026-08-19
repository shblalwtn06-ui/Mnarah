'use strict';

const express = require('express');
const Joi = require('joi');

const db = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler, parsePagination } = require('../utils/helpers');

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/products - جلب المنتجات مع الوحدات والباركودات
 */
router.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await db.query(
    `SELECT p.*, c.name AS category_name, (SELECT pb.barcode FROM product_barcodes pb WHERE pb.product_id=p.id AND pb.is_primary=true LIMIT 1) AS barcode
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.is_active = true
     ORDER BY p.name ASC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json({ products: result.rows, pagination: { page, limit } });
}));

/**
 * GET /api/products/barcode/:barcode - البحث بالباركود (لقارئ HID/الكاميرا)
 * ملاحظة: يجب أن يسبق هذا المسار GET /:id في الترتيب، وإلا سيلتقطه Express خطأً كمعرّف id
 */
router.get('/barcode/:barcode', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT p.*, pb.barcode, pu.id AS unit_id, pu.unit_name, pu.retail_price, pu.wholesale_price
     FROM product_barcodes pb
     JOIN products p ON p.id = pb.product_id
     LEFT JOIN product_units pu ON pu.id = pb.unit_id
     WHERE pb.barcode = $1 AND p.is_active = true`,
    [req.params.barcode]
  );
  if (result.rows.length === 0) throw new AppError('لم يتم العثور على منتج بهذا الباركود', 404);
  res.json({ product: result.rows[0] });
}));

/**
 * POST /api/products/search-advanced - بحث ذكي (اسم/باركود/رقم) بحد أقصى للنتائج
 */
const searchSchema = Joi.object({
  term: Joi.string().min(1).max(100).required(),
  limit: Joi.number().integer().min(1).max(50).default(15)
});
function normalizeArabicSearch(value) {
  return String(value || '')
    .trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ');
}

/**
 * بحث متقدم عربي/يمني: يطبع الحروف العربية، يبحث بالباركود والاسم والمرادفات،
 * ثم يرتب النتائج بدرجة التطابق. pg_trgm يدعم similarity والفهارس المناسبة لذلك.
 */
router.post('/search-advanced', validate(searchSchema), asyncHandler(async (req, res) => {
  const originalTerm = String(req.body.term || '').trim();
  const term = normalizeArabicSearch(originalTerm);
  const { limit } = req.body;
  const result = await db.query(
    `WITH q AS (
       SELECT $1::text AS term, COALESCE((SELECT canonical FROM search_synonyms WHERE synonym = $1 AND is_active=true LIMIT 1), $1::text) AS canonical
     ), matches AS (
       SELECT p.*, pb.barcode,
              GREATEST(
                similarity(p.search_name, q.term),
                similarity(p.search_name, q.canonical),
                COALESCE((SELECT MAX(similarity(sa.alias, q.term)) FROM product_search_aliases sa WHERE sa.product_id=p.id AND sa.is_active=true), 0)
              ) AS search_score
       FROM products p
       CROSS JOIN q
       LEFT JOIN product_barcodes pb ON pb.product_id=p.id
       WHERE p.is_active=true
         AND (
           p.search_name ILIKE '%' || q.term || '%'
           OR p.search_name ILIKE '%' || q.canonical || '%'
           OR pb.barcode = $2
           OR p.search_name % q.term
           OR p.search_name % q.canonical
           OR EXISTS (SELECT 1 FROM product_search_aliases sa WHERE sa.product_id=p.id AND sa.is_active=true AND (sa.alias ILIKE '%' || q.term || '%' OR sa.alias % q.term))
         )
     )
     SELECT DISTINCT ON (id) * FROM matches
     ORDER BY id, search_score DESC
     LIMIT $3`,
    [term, originalTerm, limit]
  );
  res.json({ products: result.rows.sort((a,b) => Number(b.search_score)-Number(a.search_score)).map(({search_score, ...product}) => product) });
}));

/**
 * GET /api/products/reports/top-selling - المنتجات الأكثر مبيعًا آخر 30 يومًا (بند 7.5 - لشاشة POS)
 * يجب أن يسبق هذا المسار GET /:id أيضًا لنفس السبب أعلاه
 */
router.get('/reports/top-selling', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 30);
  const result = await db.query(
    `SELECT p.id, p.name, p.image_url, SUM(ii.quantity) AS total_sold
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     JOIN products p ON p.id = ii.product_id
     WHERE i.invoice_type = 'sale' AND i.status = 'active' AND i.created_at > now() - interval '30 days'
     GROUP BY p.id, p.name, p.image_url
     ORDER BY total_sold DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ products: result.rows });
}));

/**
 * GET /api/products/:id - تفاصيل منتج كاملة (وحدات + باركودات)
 * يُسجَّل بعد كل المسارات الثابتة أعلاه عمدًا (barcode/, reports/) حتى لا يلتقطها Express خطأً
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const productResult = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (productResult.rows.length === 0) throw new AppError('المنتج غير موجود', 404);
  const unitsResult = await db.query('SELECT * FROM product_units WHERE product_id = $1', [req.params.id]);
  const barcodesResult = await db.query('SELECT * FROM product_barcodes WHERE product_id = $1', [req.params.id]);
  const aliasesResult = await db.query('SELECT alias FROM product_search_aliases WHERE product_id=$1 AND is_active=true ORDER BY alias', [req.params.id]);
  res.json({ product: productResult.rows[0], units: unitsResult.rows, barcodes: barcodesResult.rows, aliases: aliasesResult.rows });
}));

const productSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(), description: Joi.string().allow('', null), categoryId: Joi.string().uuid().allow(null),
  baseUnit: Joi.string().max(30).default('قطعة'), reorderPoint: Joi.number().min(0).default(0), baseCost: Joi.number().min(0).precision(2).default(0),
  retailPrice: Joi.number().min(0).precision(2).default(0), wholesalePrice: Joi.number().min(0).precision(2).default(0), wholesaleMinQty: Joi.number().min(0).precision(3).default(0),
  barcode: Joi.string().max(64).allow('', null), aliases: Joi.array().items(Joi.string().max(100)).max(20).default([]), imageUrl: Joi.string().uri().allow('', null), openingQuantity: Joi.number().min(0).precision(3).default(0), batchNumber: Joi.string().max(50).allow('', null), expiryDate: Joi.date().allow(null)
});

/**
 * POST /api/products - إضافة منتج (مدير/محاسب)
 */
router.post('/', requirePermission('can_manage_inventory'), validate(productSchema), asyncHandler(async (req, res) => {
  const { name, description, categoryId, baseUnit, reorderPoint, baseCost, retailPrice, wholesalePrice, wholesaleMinQty, barcode, aliases, imageUrl, openingQuantity, batchNumber, expiryDate } = req.body;
  const result = await db.withTransaction(async client => {
    const p=await client.query(`INSERT INTO products(name,description,category_id,base_unit,reorder_point,base_cost,image_url,base_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[name,description||null,categoryId||null,baseUnit,reorderPoint,baseCost,imageUrl||null,openingQuantity||0]);
    const unit=await client.query(`INSERT INTO product_units(product_id,unit_name,unit_code,base_quantity,is_default_sale,is_default_purchase,retail_price,wholesale_price,wholesale_min_qty) VALUES($1,$2,$3,1,true,true,$4,$5,$6) RETURNING *`,[p.rows[0].id,baseUnit,baseUnit,retailPrice,wholesalePrice,wholesaleMinQty]);
    if(barcode){await client.query(`INSERT INTO product_barcodes(product_id,unit_id,barcode,is_primary) VALUES($1,$2,$3,true)`,[p.rows[0].id,unit.rows[0].id,barcode]);}
    for (const alias of aliases || []) {
      const normalizedAlias = normalizeArabicSearch(alias);
      if (normalizedAlias) await client.query(`INSERT INTO product_search_aliases(product_id,alias,is_active) VALUES($1,$2,true) ON CONFLICT (product_id,alias) DO UPDATE SET is_active=true`, [p.rows[0].id, normalizedAlias]);
    }
    if(Number(openingQuantity)>0){const batch=await client.query(`INSERT INTO inventory_batches(product_id,batch_number,expiry_date,purchase_price,quantity_received,quantity_remaining) VALUES($1,$2,$3,$4,$5,$5) RETURNING id`,[p.rows[0].id,batchNumber||null,expiryDate||null,baseCost,openingQuantity]);await client.query(`INSERT INTO inventory_transactions(product_id,transaction_type,base_quantity,reference_id,reference_type,quantity_before,quantity_after,user_id) VALUES($1,'opening',$2,$3,'opening',0,$2,$4)`,[p.rows[0].id,openingQuantity,batch.rows[0].id,req.user.id]);}
    return {product:p.rows[0],unit:unit.rows[0]};
  });
  res.status(201).json(result);
}));

/**
 * PUT /api/products/:id - تعديل منتج
 */
const productUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(200), description: Joi.string().allow('', null), categoryId: Joi.string().uuid().allow(null),
  baseUnit: Joi.string().max(30), reorderPoint: Joi.number().min(0).precision(2), baseCost: Joi.number().min(0).precision(2),
  retailPrice: Joi.number().min(0).precision(2), wholesalePrice: Joi.number().min(0).precision(2), wholesaleMinQty: Joi.number().min(0).precision(3),
  aliases: Joi.array().items(Joi.string().max(100)).max(20), imageUrl: Joi.string().uri().allow('', null)
});

router.put('/:id', requirePermission('can_manage_inventory'), validate(productUpdateSchema), asyncHandler(async (req, res) => {
  const result = await db.withTransaction(async client=>{
    const existing=await client.query('SELECT * FROM products WHERE id=$1',[req.params.id]);
    if(!existing.rows.length) throw new AppError('المنتج غير موجود',404);
    const cur=existing.rows[0]; const b=req.body;
    const p=await client.query(`UPDATE products SET name=$1,description=$2,category_id=$3,base_unit=$4,reorder_point=$5,base_cost=$6,image_url=$7 WHERE id=$8 RETURNING *`,[b.name ?? cur.name,b.description ?? cur.description,b.categoryId ?? cur.category_id,b.baseUnit ?? cur.base_unit,b.reorderPoint ?? cur.reorder_point,b.baseCost ?? cur.base_cost,b.imageUrl ?? cur.image_url,req.params.id]);
    const unit=await client.query('SELECT * FROM product_units WHERE product_id=$1 AND is_default_sale=true LIMIT 1',[req.params.id]);
    if(unit.rows.length){ const u=unit.rows[0]; await client.query(`UPDATE product_units SET retail_price=$1,wholesale_price=$2,wholesale_min_qty=$3,unit_name=$4,unit_code=$4 WHERE id=$5`,[b.retailPrice ?? u.retail_price,b.wholesalePrice ?? u.wholesale_price,b.wholesaleMinQty ?? u.wholesale_min_qty,b.baseUnit ?? u.unit_name,u.id]); }
    if (Array.isArray(b.aliases)) {
      await client.query('UPDATE product_search_aliases SET is_active=false WHERE product_id=$1',[req.params.id]);
      for (const alias of b.aliases) { const a=normalizeArabicSearch(alias); if(a) await client.query(`INSERT INTO product_search_aliases(product_id,alias,is_active) VALUES($1,$2,true) ON CONFLICT (product_id,alias) DO UPDATE SET is_active=true`,[req.params.id,a]); }
    }
    return p.rows[0];
  });
  res.json({ product: result });
}));

/**
 * DELETE /api/products/:id - تعطيل (لا حذف فعلي حفاظًا على سجل الفواتير التاريخية)
 */
router.delete('/:id', requirePermission('can_manage_inventory'), asyncHandler(async (req, res) => {
  await db.query('UPDATE products SET is_active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
