'use strict';

/**
 * sw.js - Service Worker (بند 2.2): يخزّن أصول التطبيق (HTML/CSS/JS) في الكاش
 * بحيث تُفتح شاشة نقطة البيع حتى عند انقطاع الاتصال بخادم الفرع.
 * لا يُخزَّن أي رد من /api/* في الكاش - البيانات الحية تُدار عبر IndexedDB في offline.js
 */

const CACHE_NAME = 'almanara-smart-shell-v3.3.2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/pos.js',
  '/js/dashboard.js',
  '/js/offline.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // لا تخزين مؤقت إطلاقًا لطلبات API - يجب أن تصل مباشرة أو تفشل بوضوح ليتولى offline.js الأمر
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'لا يوجد اتصال بخادم الفرع' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Cache-first لأصول الواجهة (Shell) لضمان فتح الشاشة دون اتصال
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
