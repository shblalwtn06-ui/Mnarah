'use strict';

/**
 * offline.js - العمل offline مع IndexedDB (بند 2.2 و2.1):
 * تخزين الفواتير المُنشأة أثناء انقطاع الاتصال بخادم الفرع في قائمة انتظار محلية،
 * ومزامنتها تلقائيًا عند عودة الاتصال عبر /api/pos/sync.
 */

const OfflineSync = (() => {
  const DB_NAME = 'almanara_offline_db';
  const DB_VERSION = 2;
  const STORE_PENDING_SALES = 'pending_sales';
  const STORE_PRODUCTS = 'products_cache';
  const STORE_INVOICES = 'invoices_cache';
  const STORE_SHIFTS = 'shifts_cache';
  let db = null;
  let serverOnline = true;
  let syncing = false;

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORE_PENDING_SALES)) database.createObjectStore(STORE_PENDING_SALES, { keyPath: 'idempotencyKey' });
        if (!database.objectStoreNames.contains(STORE_PRODUCTS)) database.createObjectStore(STORE_PRODUCTS, { keyPath: 'id' });
        if (!database.objectStoreNames.contains(STORE_INVOICES)) database.createObjectStore(STORE_INVOICES, { keyPath: 'id' });
        if (!database.objectStoreNames.contains(STORE_SHIFTS)) database.createObjectStore(STORE_SHIFTS, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getDb() {
    if (!db) db = await openDb();
    return db;
  }

  /** حفظ فاتورة أُنشئت أثناء انقطاع الاتصال بخادم الفرع في قائمة الانتظار المحلية */
  async function queueSale(payload) {
    const database = await getDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_PENDING_SALES, 'readwrite');
      tx.objectStore(STORE_PENDING_SALES).put({ ...payload, queuedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllPending() {
    const database = await getDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_PENDING_SALES, 'readonly');
      const request = tx.objectStore(STORE_PENDING_SALES).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function removePending(idempotencyKey) {
    const database = await getDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_PENDING_SALES, 'readwrite');
      tx.objectStore(STORE_PENDING_SALES).delete(idempotencyKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function setServerStatus(isOnline) {
    const wasOffline = !serverOnline;
    serverOnline = isOnline;
    if (isOnline && wasOffline) {
      trySyncPending();
    }
  }

  /**
   * محاولة مزامنة كل الفواتير المعلَّقة دفعة واحدة عبر /api/pos/sync (بند 6.2)
   * كل فاتورة تُرسَل أيضًا فرديًا عبر /api/pos/sale لضمان معالجتها بمنطق البيع الكامل
   * (الدفعة إلى /sync هنا لأغراض السجل والتقرير المجمّع فقط).
   */
  async function trySyncPending() {
    if (syncing || !serverOnline) return;
    syncing = true;
    try {
      const pending = await getAllPending();
      if (pending.length === 0) { syncing = false; return; }

      showToast(`جاري مزامنة ${pending.length} فاتورة معلَّقة...`, 'warning');

      for (const sale of pending) {
        try {
          await apiFetch('/pos/sale', { method: 'POST', body: JSON.stringify(sale) });
          await removePending(sale.idempotencyKey);
        } catch (err) {
          console.error('فشل مزامنة فاتورة معلَّقة', sale.idempotencyKey, err.message);
          // تبقى في قائمة الانتظار للمحاولة التالية؛ الخادم نفسه يسجّل أي تعارض في sync_conflicts
        }
      }

      const remaining = await getAllPending();
      if (remaining.length === 0) {
        showToast('تمت مزامنة جميع الفواتير المعلَّقة بنجاح', 'success');
      } else {
        showToast(`تبقّى ${remaining.length} فاتورة لم تُزامَن - سيُعاد المحاولة تلقائيًا`, 'warning');
      }
    } finally {
      syncing = false;
    }
  }

  async function getPendingCount() {
    const pending = await getAllPending();
    return pending.length;
  }

  async function cacheRecords(storeName, records) { const database=await getDb(); return new Promise((resolve,reject)=>{ const tx=database.transaction(storeName,'readwrite'); const store=tx.objectStore(storeName); for(const r of records||[]) store.put(r); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }
  async function getCached(storeName){ const database=await getDb(); return new Promise((resolve,reject)=>{ const tx=database.transaction(storeName,'readonly'); const q=tx.objectStore(storeName).getAll(); q.onsuccess=()=>resolve(q.result); q.onerror=()=>reject(q.error); }); }
  return { queueSale, setServerStatus, trySyncPending, getPendingCount, cacheProducts: r=>cacheRecords(STORE_PRODUCTS,r), cacheInvoices:r=>cacheRecords(STORE_INVOICES,r), cacheShifts:r=>cacheRecords(STORE_SHIFTS,r), getCachedProducts:()=>getCached(STORE_PRODUCTS), getCachedInvoices:()=>getCached(STORE_INVOICES), getCachedShifts:()=>getCached(STORE_SHIFTS) };
})();

window.OfflineSync = OfflineSync;
