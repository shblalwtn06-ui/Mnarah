-- ==========================================================
-- المنارة الذكي v3.2 - مخطط قاعدة البيانات
-- PostgreSQL 14+
-- ملاحظة إلزامية: كل الحقول المالية NUMERIC(12,2) حصرًا (بند 5 من المواصفات)
-- ==========================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================================
-- المستخدمون والصلاحيات
-- ==========================================================
CREATE TABLE IF NOT EXISTS users (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username              VARCHAR(50) UNIQUE NOT NULL,
    password_hash         TEXT NOT NULL, -- argon2id
    full_name             VARCHAR(150) NOT NULL,
    role                  VARCHAR(20) NOT NULL CHECK (role IN ('admin','manager','cashier','accountant')),
    phone                 VARCHAR(30),
    is_active             BOOLEAN NOT NULL DEFAULT true,
    can_void              BOOLEAN NOT NULL DEFAULT false,
    can_view_reports      BOOLEAN NOT NULL DEFAULT false,
    can_manage_inventory  BOOLEAN NOT NULL DEFAULT false,
    failed_login_attempts SMALLINT NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,
    two_factor_enabled    BOOLEAN NOT NULL DEFAULT false,
    two_factor_secret     TEXT, -- مشفّر على مستوى التطبيق قبل التخزين
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ==========================================================
-- الورديات
-- ==========================================================
CREATE TABLE IF NOT EXISTS shifts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    closing_balance NUMERIC(12,2),
    total_sales     NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_returns   NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_cash      NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_credit    NUMERIC(12,2) NOT NULL DEFAULT 0,
    status          VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);

-- ==========================================================
-- العملاء
-- ==========================================================
CREATE TABLE IF NOT EXISTS customers (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          VARCHAR(150) NOT NULL,
    phone         VARCHAR(30),
    email         VARCHAR(150),
    address       TEXT,
    customer_type VARCHAR(10) NOT NULL DEFAULT 'retail' CHECK (customer_type IN ('retail','wholesale','both')),
    credit_limit  NUMERIC(12,2) NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS customer_balances (
    customer_id            UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    balance                NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_purchases        NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_payments          NUMERIC(12,2) NOT NULL DEFAULT 0,
    last_transaction_at    TIMESTAMPTZ,
    offline_reserved_amount NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- ==========================================================
-- الموردون
-- ==========================================================
CREATE TABLE IF NOT EXISTS suppliers (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(150) NOT NULL,
    phone      VARCHAR(30),
    email      VARCHAR(150),
    address    TEXT,
    balance    NUMERIC(12,2) NOT NULL DEFAULT 0,
    is_active  BOOLEAN NOT NULL DEFAULT true
);

-- ==========================================================
-- التصنيفات والمنتجات
-- ==========================================================
CREATE TABLE IF NOT EXISTS categories (
    id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name      VARCHAR(100) NOT NULL,
    parent_id UUID REFERENCES categories(id),
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS products (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          VARCHAR(200) NOT NULL,
    description   TEXT,
    category_id   UUID REFERENCES categories(id),
    base_unit     VARCHAR(30) NOT NULL DEFAULT 'قطعة',
    base_quantity NUMERIC(12,3) NOT NULL DEFAULT 0, -- الكمية الحالية بالوحدة الأساسية
    reorder_point NUMERIC(12,3) NOT NULL DEFAULT 0,
    base_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,
    image_url     TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS product_units (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id         UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    unit_name          VARCHAR(30) NOT NULL,
    unit_code          VARCHAR(20) NOT NULL,
    base_quantity      NUMERIC(12,3) NOT NULL DEFAULT 1, -- كم وحدة أساسية = 1 من هذه الوحدة
    is_default_sale    BOOLEAN NOT NULL DEFAULT false,
    is_default_purchase BOOLEAN NOT NULL DEFAULT false,
    allow_decimal      BOOLEAN NOT NULL DEFAULT false,
    retail_price       NUMERIC(12,2) NOT NULL DEFAULT 0,
    wholesale_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
    wholesale_min_qty  NUMERIC(12,3) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id);

CREATE TABLE IF NOT EXISTS product_barcodes (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    unit_id      UUID REFERENCES product_units(id) ON DELETE CASCADE,
    barcode_type VARCHAR(10) NOT NULL DEFAULT 'original' CHECK (barcode_type IN ('original','custom')),
    barcode      VARCHAR(64) UNIQUE NOT NULL,
    is_primary   BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode ON product_barcodes(barcode);

-- المنتجات المركّبة (Bundles) - بند 7.7
CREATE TABLE IF NOT EXISTS product_bundles (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bundle_name VARCHAR(200) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS product_bundle_items (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bundle_id          UUID NOT NULL REFERENCES product_bundles(id) ON DELETE CASCADE,
    product_id         UUID NOT NULL REFERENCES products(id),
    quantity           NUMERIC(12,3) NOT NULL,
    bundle_price_share NUMERIC(12,2) NOT NULL -- حصة هذا المنتج من سعر الباقة، لدقة COGS
);

-- ==========================================================
-- الفواتير
-- ==========================================================
CREATE TABLE IF NOT EXISTS invoices (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_number    VARCHAR(50) UNIQUE, -- رقم رسمي متسلسل - يُخصَّص عند نجاح المزامنة/الالتزام
    terminal_id       VARCHAR(50) NOT NULL,
    local_sequence    BIGINT NOT NULL,
    sync_status       VARCHAR(10) NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending','synced','conflict')),
    server_synced_at  TIMESTAMPTZ,
    invoice_type      VARCHAR(10) NOT NULL CHECK (invoice_type IN ('sale','return','purchase','void')),
    customer_id       UUID REFERENCES customers(id),
    supplier_id       UUID REFERENCES suppliers(id),
    user_id           UUID NOT NULL REFERENCES users(id),
    shift_id          UUID REFERENCES shifts(id),
    subtotal          NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_paid        NUMERIC(12,2) NOT NULL DEFAULT 0,
    change_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
    status            VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','void','refunded')),
    original_invoice_id UUID REFERENCES invoices(id),
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_terminal_seq ON invoices(terminal_id, local_sequence);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_shift ON invoices(shift_id);
CREATE INDEX IF NOT EXISTS idx_invoices_sync_status ON invoices(sync_status);

-- تسلسل الفوترة الضريبية الرسمية (بند 7.8) - بلا فجوات لكل فرع
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

CREATE TABLE IF NOT EXISTS invoice_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(id),
    unit_id         UUID REFERENCES product_units(id),
    quantity        NUMERIC(12,3) NOT NULL,
    unit_name       VARCHAR(30) NOT NULL,
    base_quantity   NUMERIC(12,3) NOT NULL,
    unit_price      NUMERIC(12,2) NOT NULL,
    cost_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_price     NUMERIC(12,2) NOT NULL,
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON invoice_items(product_id);

CREATE TABLE IF NOT EXISTS payment_methods (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name              VARCHAR(50) NOT NULL,
    type              VARCHAR(10) NOT NULL CHECK (type IN ('cash','credit','wallet','bank','other')),
    is_active         BOOLEAN NOT NULL DEFAULT true,
    requires_reference BOOLEAN NOT NULL DEFAULT false,
    icon              VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS invoice_payments (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    payment_method_id UUID NOT NULL REFERENCES payment_methods(id),
    amount           NUMERIC(12,2) NOT NULL,
    reference_number VARCHAR(100),
    notes            TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- ==========================================================
-- المخزون والدفعات (FIFO)
-- ==========================================================
CREATE TABLE IF NOT EXISTS inventory_batches (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id        UUID NOT NULL REFERENCES products(id),
    supplier_id       UUID REFERENCES suppliers(id),
    batch_number      VARCHAR(50),
    received_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    expiry_date       DATE,
    purchase_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
    quantity_received NUMERIC(12,3) NOT NULL,
    quantity_remaining NUMERIC(12,3) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_product ON inventory_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry ON inventory_batches(expiry_date) WHERE quantity_remaining > 0;

CREATE TABLE IF NOT EXISTS inventory_transactions (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id       UUID NOT NULL REFERENCES products(id),
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN
        ('sale','purchase','return_in','return_out','adjustment','void_restore','opening')),
    base_quantity    NUMERIC(12,3) NOT NULL, -- موجب دخول / سالب خروج
    reference_id     UUID,
    reference_type   VARCHAR(30),
    quantity_before  NUMERIC(12,3) NOT NULL,
    quantity_after   NUMERIC(12,3) NOT NULL,
    user_id          UUID REFERENCES users(id),
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_tx_product ON inventory_transactions(product_id);

-- حصص المخزون لكل جهاز أثناء العمل offline (Stock Partitioning - تصحيح v3.2)
CREATE TABLE IF NOT EXISTS terminal_stock_partitions (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    terminal_id       VARCHAR(50) NOT NULL,
    product_id        UUID NOT NULL REFERENCES products(id),
    allocated_quantity NUMERIC(12,3) NOT NULL,
    remaining_quantity NUMERIC(12,3) NOT NULL,
    allocated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at       TIMESTAMPTZ,
    UNIQUE (terminal_id, product_id, allocated_at)
);
CREATE INDEX IF NOT EXISTS idx_terminal_partitions_active ON terminal_stock_partitions(terminal_id, product_id) WHERE released_at IS NULL;

-- ==========================================================
-- المحاسبة
-- ==========================================================
CREATE TABLE IF NOT EXISTS ledger_entries (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entry_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    account_code   VARCHAR(20) NOT NULL,
    account_name   VARCHAR(100) NOT NULL,
    debit          NUMERIC(12,2) NOT NULL DEFAULT 0,
    credit         NUMERIC(12,2) NOT NULL DEFAULT 0,
    reference_id   UUID,
    reference_type VARCHAR(30),
    description    TEXT,
    user_id        UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON ledger_entries(entry_date);

CREATE TABLE IF NOT EXISTS voided_invoices (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    original_invoice_id UUID NOT NULL REFERENCES invoices(id),
    voided_by           UUID NOT NULL REFERENCES users(id),
    manager_approved_by UUID REFERENCES users(id),
    security_code_used  VARCHAR(10),
    reason               TEXT NOT NULL,
    total_amount         NUMERIC(12,2) NOT NULL,
    original_data         JSONB NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==========================================================
-- الأمان والجلسات
-- ==========================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    device_info TEXT,
    ip_address  VARCHAR(45),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES users(id),
    action_type VARCHAR(50) NOT NULL,
    table_name  VARCHAR(50),
    record_id   UUID,
    old_values  JSONB,
    new_values  JSONB,
    ip_address  VARCHAR(45),
    device_info TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

-- ==========================================================
-- المزامنة (Offline Sync - القسم 2.2)
-- ==========================================================
CREATE TABLE IF NOT EXISTS sync_queue (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name  VARCHAR(50) NOT NULL,
    record_id   UUID NOT NULL,
    action      VARCHAR(10) NOT NULL CHECK (action IN ('insert','update','delete')),
    data        JSONB NOT NULL,
    synced      BOOLEAN NOT NULL DEFAULT false,
    synced_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue(synced) WHERE synced = false;

CREATE TABLE IF NOT EXISTS sync_conflicts (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name        VARCHAR(50) NOT NULL,
    record_id         UUID NOT NULL,
    terminal_id       VARCHAR(50) NOT NULL,
    conflict_type     VARCHAR(50) NOT NULL,
    resolution_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (resolution_status IN ('pending','resolved','ignored')),
    resolved_by       UUID REFERENCES users(id),
    details           JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_pending ON sync_conflicts(resolution_status) WHERE resolution_status = 'pending';

-- ==========================================================
-- إشعارات، صرف عملات، مصاريف
-- ==========================================================
CREATE TABLE IF NOT EXISTS notifications_log (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type           VARCHAR(20) NOT NULL, -- whatsapp/email/sms
    recipient      VARCHAR(150) NOT NULL,
    message        TEXT,
    attachment_url TEXT,
    status         VARCHAR(20) NOT NULL DEFAULT 'pending',
    sent_at        TIMESTAMPTZ,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exchange_rate_snapshots (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_currency VARCHAR(10) NOT NULL,
    to_currency   VARCHAR(10) NOT NULL,
    rate          NUMERIC(14,6) NOT NULL,
    source        VARCHAR(50),
    set_by        UUID REFERENCES users(id),
    effective_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expense_type      VARCHAR(20) NOT NULL CHECK (expense_type IN ('operational','personal','damage','other')),
    amount            NUMERIC(12,2) NOT NULL,
    description       TEXT,
    expense_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    receipt_image_url TEXT,
    recorded_by       UUID REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==========================================================
-- بيانات أولية أساسية (Seed دنيا لتشغيل النظام)
-- ==========================================================
INSERT INTO payment_methods (name, type, requires_reference, icon)
SELECT v.name,v.type,v.requires_reference,v.icon
FROM (VALUES ('نقدي','cash',false,'💰'),('محفظة إلكترونية','wallet',true,'📱'),('حوالة بنكية','bank',true,'🏦'),('آجل','credit',false,'📋')) v(name,type,requires_reference,icon)
WHERE NOT EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.name=v.name);

-- ملاحظة: يُنشأ أول مستخدم admin عبر scripts/seed.js (كلمة المرور تُجزّأ بـ argon2id وليست نصًا صريحًا هنا)

-- ==========================================================
-- المنارة الذكي v3.3 - المحاسبة والضرائب والعملات والخرج اليومي
-- ==========================================================

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
    normal_balance VARCHAR(6) NOT NULL CHECK (normal_balance IN ('debit','credit')),
    parent_id UUID REFERENCES accounts(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_id);

CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entry_number BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE,
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    description TEXT NOT NULL,
    reference_id UUID,
    reference_type VARCHAR(40),
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_reference ON journal_entries(reference_id, reference_type);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id),
    debit NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    description TEXT,
    CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_entry_lines(account_id);

CREATE OR REPLACE FUNCTION enforce_balanced_journal_entry() RETURNS trigger AS $$
DECLARE
    total_debit NUMERIC(12,2);
    total_credit NUMERIC(12,2);
BEGIN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
      INTO total_debit, total_credit
      FROM journal_entry_lines WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
    IF total_debit <> total_credit THEN
        RAISE EXCEPTION 'القيد المحاسبي غير متوازن: مدين=% دائن=%', total_debit, total_credit;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_balanced_journal_entry ON journal_entry_lines;
CREATE CONSTRAINT TRIGGER trg_balanced_journal_entry
AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal_entry();

CREATE TABLE IF NOT EXISTS cash_drawer_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id UUID NOT NULL REFERENCES shifts(id),
    user_id UUID NOT NULL REFERENCES users(id),
    type VARCHAR(20) NOT NULL CHECK (type IN ('withdrawal','deposit')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reason VARCHAR(500) NOT NULL,
    approved_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drawer_shift ON cash_drawer_transactions(shift_id, created_at DESC);

CREATE TABLE IF NOT EXISTS taxes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    rate NUMERIC(12,2) NOT NULL CHECK (rate >= 0 AND rate <= 100),
    type VARCHAR(20) NOT NULL DEFAULT 'percentage' CHECK (type IN ('percentage','fixed')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    account_id UUID REFERENCES accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS tax_id UUID REFERENCES taxes(id);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number VARCHAR(50) UNIQUE NOT NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    user_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partially_received','received','cancelled')),
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    unit_id UUID REFERENCES product_units(id),
    quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    tax_id UUID REFERENCES taxes(id),
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_order ON purchase_order_items(purchase_order_id);

CREATE TABLE IF NOT EXISTS currencies (
    code VARCHAR(10) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    symbol VARCHAR(10) NOT NULL,
    is_base BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS exchange_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_currency VARCHAR(10) NOT NULL REFERENCES currencies(code),
    to_currency VARCHAR(10) NOT NULL REFERENCES currencies(code),
    rate NUMERIC(12,2) NOT NULL CHECK (rate > 0),
    effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    set_by UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair ON exchange_rates(from_currency, to_currency, effective_at DESC);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10) REFERENCES currencies(code);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,2) NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS foreign_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE exchange_rate_snapshots ALTER COLUMN rate TYPE NUMERIC(12,2);

INSERT INTO accounts(code,name,account_type,normal_balance) VALUES
('1110','الصندوق','asset','debit'),
('1120','البنك والمحافظ','asset','debit'),
('1130','ذمم العملاء','asset','debit'),
('1140','المخزون','asset','debit'),
('1150','ضريبة مدخلات','asset','debit'),
('2110','ذمم الموردين','liability','credit'),
('3110','رأس المال','equity','credit'),
('4110','إيراد المبيعات','revenue','credit'),
('5110','تكلفة البضاعة المباعة','expense','debit'),
('6110','مصاريف تشغيلية','expense','debit'),
('6120','سحوبات شخصية','equity','debit'),
('7110','ضريبة مستحقة','liability','credit')
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, account_type=EXCLUDED.account_type, normal_balance=EXCLUDED.normal_balance;

INSERT INTO currencies(code,name,symbol,is_base) VALUES
('YER','الريال اليمني','﷼',true),
('SAR','الريال السعودي','﷼',false),
('USD','الدولار الأمريكي','$',false)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, symbol=EXCLUDED.symbol, is_base=EXCLUDED.is_base;

INSERT INTO exchange_rates(from_currency,to_currency,rate)
VALUES ('SAR','YER',67.00),('USD','YER',500.00),('YER','YER',1.00)
ON CONFLICT DO NOTHING;

INSERT INTO taxes(name,rate,type,is_active,account_id)
SELECT 'ضريبة افتراضية',0,'percentage',true,id FROM accounts WHERE code='7110'
AND NOT EXISTS (SELECT 1 FROM taxes WHERE name='ضريبة افتراضية');

CREATE OR REPLACE VIEW v_trial_balance AS
SELECT a.code,a.name,a.account_type,a.normal_balance,
       COALESCE(SUM(jl.debit),0)::NUMERIC(12,2) AS debit,
       COALESCE(SUM(jl.credit),0)::NUMERIC(12,2) AS credit,
       (COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0))::NUMERIC(12,2) AS balance
FROM accounts a LEFT JOIN journal_entry_lines jl ON jl.account_id=a.id
GROUP BY a.id,a.code,a.name,a.account_type,a.normal_balance;

CREATE TABLE IF NOT EXISTS search_synonyms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    synonym VARCHAR(100) UNIQUE NOT NULL,
    canonical VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_synonyms_synonym ON search_synonyms(synonym);

CREATE TABLE IF NOT EXISTS product_search_aliases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alias VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(product_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_product_search_aliases_alias_trgm ON product_search_aliases USING GIN (alias gin_trgm_ops);

ALTER TABLE products ADD COLUMN IF NOT EXISTS search_name TEXT;
UPDATE products SET search_name = lower(translate(name, 'أإآٱىةؤئ', 'اااايهوي')) WHERE search_name IS NULL;
ALTER TABLE products ALTER COLUMN search_name SET DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_products_search_name_trgm ON products USING GIN (search_name gin_trgm_ops);

CREATE OR REPLACE FUNCTION sync_product_search_name() RETURNS trigger AS $$
BEGIN
  NEW.search_name := lower(translate(coalesce(NEW.name,''), 'أإآٱىةؤئ', 'اااايهوي'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_products_search_name ON products;
CREATE TRIGGER trg_products_search_name BEFORE INSERT OR UPDATE OF name ON products FOR EACH ROW EXECUTE FUNCTION sync_product_search_name();

INSERT INTO search_synonyms(synonym, canonical) VALUES
('مويه','ماء'),('ميه','ماء'),('موية','ماء'),('بطاطا','بطاطس'),('بصل اخضر','بصل'),('طماطه','طماطم'),('طماطة','طماطم'),('بسباس','فلفل'),('فلفل حار','فلفل')
ON CONFLICT (synonym) DO UPDATE SET canonical=EXCLUDED.canonical, is_active=true;

CREATE TABLE IF NOT EXISTS company_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
