// اسم الكاش لتخزين الملفات
const CACHE_NAME = 'student-report-cache-v1';

// قائمة الملفات الأساسية التي نريد تخزينها (هيكل التطبيق)
const urlsToCache = [
  '/', // الصفحة الرئيسية
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/framer-motion@10/dist/framer-motion.umd.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap',
  '/manifest.webmanifest',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// 1. عند "تثبيت" الـ Service Worker، قم بتخزين الملفات الأساسية
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// 2. عند طلب أي ملف (fetch)، تحقق إذا كان موجوداً في الكاش أولاً
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // إذا وجدناه في الكاش، أرجعه مباشرة
        if (response) {
          return response;
        }
        // إذا لم نجده، اطلبه من الشبكة
        return fetch(event.request);
      }
    )
  );
});