# المنارة الذكي v3.3

نظام POS/ERP عربي RTL، Offline-First، مبني على Node.js + Express + PostgreSQL.

## المتطلبات
- Node.js 18+
- PostgreSQL 14+ (موصى 16)
- متصفح حديث يدعم IndexedDB وService Worker

## التشغيل المحلي
1. انسخ `.env.example` إلى `.env`.
2. أنشئ قاعدة PostgreSQL ومستخدمًا بصلاحيات إنشاء الجداول.
3. نفّذ:

```bash
npm install
npm run migrate
node scripts/seed.js admin كلمة-مرور-قوية-هنا
npm test
npm start
```

ثم افتح `http://localhost:3000`.

## Docker

```bash
docker compose up --build -d
```

بعد جاهزية قاعدة البيانات:

```bash
docker compose exec app npm run migrate
docker compose exec app node scripts/seed.js admin كلمة-مرور-قوية-هنا
```

## أهم المسارات
- `/api/auth`
- `/api/pos`
- `/api/products`
- `/api/customers`
- `/api/suppliers`
- `/api/inventory`
- `/api/reports`
- `/api/shifts`
- `/api/payment-methods`
- `/api/whatsapp`
- `/api/accounting`
- `/api/health`

## v3.3
تشمل المحاسبة المزدوجة، دفتر الأستاذ، ميزان المراجعة، قائمة الدخل، الميزانية العمومية، الخرج اليومي، الضرائب، العملات المتعددة، أوامر الشراء، المصروفات، وواجهة إدارية أوسع.

راجع `FINAL_AUDIT_V3.3.md` قبل الإنتاج.
