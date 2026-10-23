/* 简易笔记 网页版 Service Worker —— 让网页版可"安装到主屏"且离线可用。
 * 应用外壳（页面/脚本/样式/图标）缓存优先；/api 与实时同步始终走网络、不缓存。
 * 注：Service Worker 需要安全上下文（HTTPS 或 localhost）才能注册生效；
 *     当前 NAS 走 http://192.168.x 局域网时注册会静默失败（被 catch 吞掉），
 *     届时仍可"添加到主屏幕"（靠 apple-touch-icon），但离线缓存需待配置 HTTPS。 */
const CACHE = "easynote-web-v1";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "styles.css",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(function (c) {
        return c.addAll(SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k !== CACHE;
            })
            .map(function (k) {
              return caches.delete(k);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // 同步接口：永远走网络，失败不缓存
  if (url.pathname.indexOf("/api/") === 0) {
    e.respondWith(
      fetch(req).catch(function () {
        return new Response("", { status: 503, statusText: "offline" });
      })
    );
    return;
  }

  // 同源资源：缓存优先，离线可加载；缺失时回退到已缓存的 index.html
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) return cached;
        return fetch(req)
          .then(function (res) {
            if (res && res.ok && res.type === "basic") {
              var copy = res.clone();
              caches.open(CACHE).then(function (c) {
                c.put(req, copy);
              });
            }
            return res;
          })
          .catch(function () {
            return caches.match("index.html");
          });
      })
    );
  }
});
