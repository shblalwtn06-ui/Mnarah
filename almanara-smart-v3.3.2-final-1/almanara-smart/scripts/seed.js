'use strict';

/**
 * سكربت إنشاء أول مستخدم admin - يُشغَّل مرة واحدة بعد تنفيذ schema.sql
 * الاستخدام: node scripts/seed.js <username> <password>
 * كلمة المرور تُجزَّأ بـ argon2id قبل التخزين - لا تُخزَّن أبدًا كنص صريح
 */

require('dotenv').config();
const argon2 = require('argon2');
const { pool } = require('../config/db');

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('الاستخدام: node scripts/seed.js <username> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('كلمة المرور يجب ألا تقل عن 8 أحرف');
    process.exit(1);
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST || '19456', 10),
    timeCost: parseInt(process.env.ARGON2_TIME_COST || '2', 10),
    parallelism: parseInt(process.env.ARGON2_PARALLELISM || '1', 10)
  });

  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length > 0) {
    console.error('اسم المستخدم موجود بالفعل');
    process.exit(1);
  }

  await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role, can_void, can_view_reports, can_manage_inventory)
     VALUES ($1, $2, 'المدير العام', 'admin', true, true, true)`,
    [username, passwordHash]
  );

  console.log(`تم إنشاء المستخدم "${username}" بدور admin بنجاح.`);
  console.log('يُنصح بشدة بتفعيل التوثيق الثنائي (2FA) فور تسجيل الدخول الأول.');
  await pool.end();
}

main().catch((err) => {
  console.error('فشل تنفيذ السكربت:', err.message);
  process.exit(1);
});
