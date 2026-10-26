/* 简易笔记 网页版 Service Worker —— 让网页版可"安装到主屏"且离线可用。
 * 页面 / 脚本 / 样式 → 网络优先（在线拿到最新，离线回退缓存）；
 * 图片等静态资源 → 缓存优先（省流量）；/api 与实时同步始终走网络、不缓存。
 * 注：Service Worker 需要安全上下文（HTTPS 或 localhost）才能注册生效；
 *     当前 NAS 走 http://192.168.x 局域网时注册会静默失败（被 catch 吞掉），
 *     届时仍可"添加到主屏幕"（靠 apple-touch-icon），但离线缓存需待配置 HTTPS。 */
const CACHE = "easynote-web-v22";
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

  // 同源资源：
  // 页面/脚本/样式 → 网络优先（在线总能拿到最新版本），失败才回退缓存（离线可用）；
  //   若反过来「缓存优先」，服务端更新了 app.js，已安装 PWA 的手机仍会读到旧缓存，修复到不了用户。
  // 图片等静态资源 → 缓存优先（基本不变，省流量）。
  if (url.origin === self.location.origin) {
    var isAsset = /\.(png|jpe?g|gif|svg|webp|ico|woff2?)$/i.test(url.pathname);

    if (isAsset) {
      e.respondWith(
        caches.match(req).then(function (cached) {
          if (cached) return cached;
          return fetch(req).then(function (res) {
            if (res && res.ok && res.type === "basic") {
              var copy = res.clone();
              caches.open(CACHE).then(function (c) { c.put(req, copy); });
            }
            return res;
          });
        })
      );
      return;
    }

    e.respondWith(
      fetch(req)
        .then(function (res) {
          if (res && res.ok && res.type === "basic") {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          // 离线：页面请求回退到已缓存的首页，其它资源直接取缓存
          return caches.match(req).then(function (cached) {
            if (cached) return cached;
            if (req.mode === "navigate") return caches.match("index.html");
            return new Response("", { status: 504, statusText: "offline" });
          });
        })
    );
  }
});
