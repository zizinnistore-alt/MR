const CACHE_NAME = 'student-report-cache-v5'; // غيّرنا الرقم لفرض التحديث

// قائمة الملفات المحلية فقط التي يمكننا التحكم بها وتخزينها بأمان
const APP_SHELL_URLS = [
  '/', // الصفحة الرئيسية
  '/manifest.webmanifest',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
  // تمت إزالة كل الروابط الخارجية (CDNs) من هنا
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => {
    console.log('SW: Caching app shell');
    return cache.addAll(APP_SHELL_URLS);
  }));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(cacheNames => {
    return Promise.all(
      cacheNames.map(cacheName => {
        if (cacheName !== CACHE_NAME) {
          return caches.delete(cacheName);
        }
      })
    );
  }));
});

self.addEventListener('fetch', event => {
  // --- الجزء المُعدّل ---

  // 1. تجاهل كل الطلبات التي ليست من نوع GET
  if (event.request.method !== 'GET') return;

  // 2. تجاهل الطلبات التي لا تبدأ بـ http (مثل chrome-extension://)
  if (!event.request.url.startsWith('http')) return;

  // 3. تجاهل طلبات المصادقة أو التحليلات إذا كانت موجودة (للمستقبل)
  if (event.request.url.includes('google-analytics')) return;

  // استراتيجية Cache-First للطلبات الصالحة فقط
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      // إذا كان الطلب موجوداً في الكاش، أرجعه
      if (cachedResponse) {
        return cachedResponse;
      }
      
      // إذا لم يكن موجوداً، اطلبه من الشبكة، خزنه في الكاش، ثم أرجعه
      return fetch(event.request).then(networkResponse => {
        // تأكد من أن الرد صالح قبل تخزينه
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});