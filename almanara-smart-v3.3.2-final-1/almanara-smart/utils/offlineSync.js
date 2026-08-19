'use strict';

const logger = require('./logger');

/**
 * منطق تقسيم المخزون بين الأجهزة العاملة (Stock Partitioning)
 * تصحيح v3.2: لا نستخدم نسبة ثابتة (كانت 90% في v3.1) لأنها تُحسب لكل جهاز
 * بشكل مستقل وتسمح ببيع أكثر من المخزون الفعلي عند تعدد الأجهزة offline.
 * بدلاً من ذلك: الكمية الحقيقية تُقسَّم صراحة بين الأجهزة العاملة حاليًا،
 * بحيث يبقى المجموع الكلي القابل للبيع offline من كل الأجهزة = الكمية الفعلية بالضبط.
 *
 * الحد الأدنى لكمية المخزون الحرجة (reorder_point) يُمنع بيعها offline كليًا -
 * انظر شرط `reorder_point` في route المنتجات/المزامنة.
 */

/**
 * حساب حصة كل جهاز من كمية منتج معيّن
 * @param {number} totalQuantity الكمية الحقيقية الحالية في قاعدة البيانات المركزية
 * @param {number} activeTerminalsCount عدد الأجهزة المتصلة/النشطة حاليًا بخادم الفرع
 * @returns {number} الكمية المخصَّصة لكل جهاز (مقربة لأسفل لتفادي التجاوز التراكمي)
 */
function calculatePartitionShare(totalQuantity, activeTerminalsCount) {
  const count = Math.max(activeTerminalsCount, 1);
  // تقريب لأسفل عمدًا: مجموع الحصص المقرّبة لأسفل ضمانًا ألا يتجاوز مجموعها totalQuantity
  return Math.floor((totalQuantity / count) * 1000) / 1000;
}

/**
 * يحدد ما إذا كان منتج معيّن مسموحًا ببيعه offline إطلاقًا
 * وفق القسم 2.2: يُمنع البيع offline للمنتجات الحرجة/منخفضة المخزون
 */
function isEligibleForOfflineSale(product) {
  const qty = parseFloat(product.base_quantity);
  const reorderPoint = parseFloat(product.reorder_point);
  return qty > reorderPoint * 1.2; // هامش أمان فوق نقطة إعادة الطلب
}

/**
 * تسجيل حصة مخزون جديدة لجهاز عند دخوله وضع offline (تُستدعى من route المزامنة/الفتح)
 */
async function allocatePartition(client, { terminalId, productId, quantity }) {
  const result = await client.query(
    `INSERT INTO terminal_stock_partitions (terminal_id, product_id, allocated_quantity, remaining_quantity)
     VALUES ($1, $2, $3, $3) RETURNING *`,
    [terminalId, productId, quantity]
  );
  return result.rows[0];
}

/**
 * تسجيل تعارض مزامنة لمراجعة يدوية من المدير (بند 2.2 و10 من المواصفات)
 */
async function logSyncConflict(client, { tableName, recordId, terminalId, conflictType, details }) {
  await client.query(
    `INSERT INTO sync_conflicts (table_name, record_id, terminal_id, conflict_type, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [tableName, recordId, terminalId, conflictType, JSON.stringify(details || {})]
  );
  logger.warn('تم تسجيل تعارض مزامنة يتطلب مراجعة يدوية', { tableName, recordId, terminalId, conflictType });
}

/**
 * دمج حركة مخزون واردة من جهاز أثناء المزامنة بمنطق تراكمي (delta-based)
 * وليس last-write-wins، لتفادي فقدان مبيعات فعلية حدثت على أجهزة متعددة (بند 2.2)
 */
async function mergeInventoryDelta(client, { productId, deltaQuantity, referenceId, referenceType, userId, notes }) {
  const productResult = await client.query(
    'SELECT base_quantity FROM products WHERE id = $1 FOR UPDATE',
    [productId]
  );
  if (productResult.rows.length === 0) {
    throw new Error('المنتج غير موجود لدمج حركة المزامنة');
  }
  const before = parseFloat(productResult.rows[0].base_quantity);
  const after = before + deltaQuantity;

  await client.query('UPDATE products SET base_quantity = $1 WHERE id = $2', [after, productId]);

  await client.query(
    `INSERT INTO inventory_transactions
      (product_id, transaction_type, base_quantity, reference_id, reference_type, quantity_before, quantity_after, user_id, notes)
     VALUES ($1, 'adjustment', $2, $3, $4, $5, $6, $7, $8)`,
    [productId, deltaQuantity, referenceId, referenceType, before, after, userId, notes || 'دمج مزامنة offline']
  );

  return { before, after, negative: after < 0 };
}

module.exports = {
  calculatePartitionShare,
  isEligibleForOfflineSale,
  allocatePartition,
  logSyncConflict,
  mergeInventoryDelta
};
