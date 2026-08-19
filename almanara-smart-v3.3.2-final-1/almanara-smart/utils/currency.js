'use strict';

/**
 * أداة حسابات مالية دقيقة - تعمل على الأعداد الصحيحة (هللات/فلوس) داخليًا
 * لتفادي أخطاء التقريب الشائعة عند استخدام Float مباشرة في JavaScript.
 * كل الحقول المالية في قاعدة البيانات NUMERIC(12,2) - هذه الأداة تحافظ على نفس الدقة
 * في طبقة التطبيق (بند 5 من المواصفات).
 */

const SCALE = 100; // خانتان عشريتان

/** تحويل رقم عشري إلى وحدات صحيحة صغيرة (فلوس) لتفادي أخطاء الفاصلة العائمة */
function toMinorUnits(amount) {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (Number.isNaN(n)) throw new Error('قيمة مالية غير صالحة');
  return Math.round(n * SCALE);
}

function fromMinorUnits(minor) {
  return Math.round(minor) / SCALE;
}

function add(a, b) {
  return fromMinorUnits(toMinorUnits(a) + toMinorUnits(b));
}

function subtract(a, b) {
  return fromMinorUnits(toMinorUnits(a) - toMinorUnits(b));
}

function multiply(amount, factor) {
  // factor قد يكون كمية بدقة ثلاث خانات عشرية (وحدات المنتج)
  const minor = toMinorUnits(amount);
  return fromMinorUnits(Math.round(minor * factor));
}

function sum(amounts) {
  return fromMinorUnits(amounts.reduce((acc, v) => acc + toMinorUnits(v), 0));
}

/** يقارن مبلغين مع هامش تسامح صغير جدًا لتفادي أخطاء تمثيل الفاصلة العائمة */
function isGreaterOrEqual(a, b) {
  return toMinorUnits(a) >= toMinorUnits(b);
}

function round2(amount) {
  return fromMinorUnits(toMinorUnits(amount));
}

function formatCurrency(amount, currency = 'ر.ي') {
  const value = round2(amount).toFixed(2);
  return `${value} ${currency}`;
}

module.exports = {
  toMinorUnits, fromMinorUnits, add, subtract, multiply, sum,
  isGreaterOrEqual, round2, formatCurrency
};
