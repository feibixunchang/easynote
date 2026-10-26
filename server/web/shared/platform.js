/* ============ 简易笔记 · 平台适配层（单一来源）shared/platform.js ============
 * 目标：业务代码（app.js）不再直接判断"我在 Electron 还是手机还是在浏览器"，
 *      统一调用 EZPlatform.* ，各端差异集中在这里。
 *
 * 三端：
 *   · electron  ：桌面端，能力来自 preload 暴露的 window.electronAPI
 *   · capacitor ：移动端（iOS/Android），能力来自 Capacitor 插件
 *   · browser   ：网页版，用 Web API 实现（复制 / 打开链接 / 下载文件等）
 *
 * 用法：
 *   EZPlatform.name                      // "electron" | "capacitor" | "browser"
 *   EZPlatform.openExternal(url)          // 用系统浏览器打开链接
 *   EZPlatform.copyText(text)             // 写剪贴板（Promise）
 *   EZPlatform.readText()                 // 读剪贴板（Promise<string>）
 *   EZPlatform.saveTextFile({defaultName, content}) // 保存文本文件（Promise）
 *   EZPlatform.bridge                     // 与 electronAPI 同形的对象，可直接替换 window.electronAPI 的用法
 *
 * 生成/校验：tools/build-shared.sh 会把本文件复制到移动端与网页版目录并比对一致；
 *           tools/parity-check.sh 在 CI 里强制校验。
 * ============================================================ */
(function (root) {
  "use strict";

  var hasWindow = typeof window !== "undefined" && !!window;
  var w = hasWindow ? window : root;

  /* ---------- 环境探测 ---------- */
  var isElectron = !!(w.electronAPI && w.electronAPI.openExternal) ||
    /electron/i.test((w.navigator && w.navigator.userAgent) || "");
  var cap = w.Capacitor;
  var isCapacitor = !!(cap && (cap.isNativePlatform ? cap.isNativePlatform() : (cap.getPlatform && cap.getPlatform() !== "web")));
  var NAME = isElectron ? "electron" : (isCapacitor ? "capacitor" : "browser");

  /* ---------- Capacitor 插件取用（拿不到就返回 null，调用方自行兜底）---------- */
  function plug(name) {
    try {
      if (cap && cap.Plugins && cap.Plugins[name]) return cap.Plugins[name];
      if (w.Capacitor && w.Capacitor.Plugins && w.Capacitor.Plugins[name]) return w.Capacitor.Plugins[name];
    } catch (e) {}
    return null;
  }

  /* ---------- Web 兜底实现（浏览器/降级时用）---------- */
  function webOpenExternal(url) {
    try { w.open(url, "_blank", "noopener"); } catch (e) { try { location.href = url; } catch (e2) {} }
  }
  function webCopyText(text) {
    text = String(text == null ? "" : text);
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.writeText) {
      return w.navigator.clipboard.writeText(text).catch(function () { return webCopyFallback(text); });
    }
    return Promise.resolve(webCopyFallback(text));
  }
  function webCopyFallback(text) {
    try {
      var ta = w.document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      w.document.body.appendChild(ta);
      ta.select();
      w.document.execCommand("copy");
      w.document.body.removeChild(ta);
    } catch (e) {}
  }
  function webReadText() {
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.readText) {
      return w.navigator.clipboard.readText().catch(function () { return ""; });
    }
    return Promise.resolve("");
  }
  function webSaveTextFile(opts) {
    opts = opts || {};
    try {
      var blob = new w.Blob([String(opts.content || "")], { type: (opts.mime || "text/plain") + ";charset=utf-8" });
      var a = w.document.createElement("a");
      a.href = w.URL.createObjectURL(blob);
      a.download = String(opts.defaultName || "note.txt");
      w.document.body.appendChild(a);
      a.click();
      w.setTimeout(function () { w.URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Promise.resolve({ ok: true, path: a.download });
    } catch (e) {
      return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
    }
  }

  /* ---------- 画布等比压缩（移动端插图用；桌面端由主进程原生压缩）---------- */
  function resizeDataUrl(dataUrl, max) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      // 安全网：个别 WebView 上 onload 可能不触发，5 秒后原样返回，绝不卡住插入流程
      w.setTimeout(function () { finish(dataUrl); }, 5000);
      var img = new w.Image();
      img.onload = function () {
        try {
          var iw = img.naturalWidth || img.width;
          var ih = img.naturalHeight || img.height;
          var scale = Math.min(1, max / Math.max(iw, ih));
          if (scale >= 1) { finish(dataUrl); return; }
          var canvas = w.document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(iw * scale));
          canvas.height = Math.max(1, Math.round(ih * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          var out = canvas.toDataURL("image/jpeg", 0.85);
          finish(out && out.length < dataUrl.length ? out : dataUrl);
        } catch (e) { finish(dataUrl); }
      };
      img.onerror = function () { finish(dataUrl); };
      img.src = dataUrl;
    });
  }

  /* ---------- 版本标签解析 + GitHub 标签获取（更新检查用，三端共用）---------- */
  var DESKTOP_TAG_RE = /^v(\d+(?:\.\d+){1,2})$/;
  var MOBILE_TAG_RE = /^mobile-v(\d+(?:\.\d+){1,2})$/;
  function cmpVersion(a, b) {
    var pa = String(a).split(".").map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b).split(".").map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  function pickMaxVersion(tags, re) {
    var best = null;
    (tags || []).forEach(function (t) {
      var m = re.exec(String(t || ""));
      if (!m) return;
      if (!best || cmpVersion(m[1], best) > 0) best = m[1];
    });
    return best;
  }
  // 取仓库的 release 标签：官方 API → 公共镜像 → releases.atom 兜底（国内 API 常被限流）
  function fetchGithubTags(repo) {
    var api = "https://api.github.com/repos/" + repo + "/releases?per_page=20";
    var urls = [api, "https://ghproxy.com/" + api, "https://mirror.ghproxy.com/" + api, "https://github.bibaiyu.com/" + api];
    function tryApi(i) {
      if (i >= urls.length) return Promise.reject(new Error("api unavailable"));
      return fetchWithTimeout(urls[i], 9000).then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      }).then(function (list) {
        if (!Array.isArray(list)) throw new Error("bad data");
        var tags = list.map(function (x) { return x && x.tag_name; });
        if (!tags.length) throw new Error("empty");
        return tags;
      }).catch(function () { return tryApi(i + 1); });
    }
    function atomFallback() {
      return fetchWithTimeout("https://github.com/" + repo + "/releases.atom", 9000)
        .then(function (r) { return r.text(); })
        .then(function (xml) {
          var re = /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g;
          var out = [], m;
          while ((m = re.exec(xml)) !== null) out.push(m[1]);
          return out;
        })
        .catch(function () { return []; });
    }
    return tryApi(0).catch(atomFallback);
  }
  function fetchWithTimeout(url, ms) {
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? w.setTimeout(function () { ctrl.abort(); }, ms || 12000) : null;
    return w.fetch(url, { signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
      if (timer) w.clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) w.clearTimeout(timer);
      throw e;
    });
  }

  /* ---------- 统一接口（各端按能力覆盖）---------- */
  var api = {
    name: NAME,
    isElectron: NAME === "electron",
    isCapacitor: NAME === "capacitor",
    isBrowser: NAME === "browser",

    openExternal: function (url) {
      if (!url) return;
      if (NAME === "electron") { w.electronAPI.openExternal(url); return; }
      if (NAME === "capacitor") {
        var b = plug("Browser");
        if (b && b.open) { b.open({ url: url }).catch(function () { webOpenExternal(url); }); return; }
      }
      webOpenExternal(url);
    },

    copyText: function (text) {
      if (NAME === "electron" && w.electronAPI.writeClipboard) return Promise.resolve(w.electronAPI.writeClipboard(String(text == null ? "" : text)));
      if (NAME === "capacitor") {
        var c = plug("Clipboard");
        if (c && c.writeText) return Promise.resolve(c.writeText({ string: String(text == null ? "" : text) }));
      }
      return webCopyText(text);
    },

    readText: function () {
      if (NAME === "electron" && w.electronAPI.getClipboardText) return Promise.resolve(w.electronAPI.getClipboardText()).then(function (t) { return t || ""; });
      if (NAME === "capacitor") {
        var c = plug("Clipboard");
        if (c && c.read) return Promise.resolve(c.read()).then(function (r) { return (r && r.value) || ""; });
      }
      return webReadText();
    },

    saveTextFile: function (opts) {
      if (NAME === "electron" && w.electronAPI.saveFile) return Promise.resolve(w.electronAPI.saveFile(opts));
      // 移动端：Capacitor Filesystem（见下方 bridge）；浏览器：走下载。
      // 注意：这里不能无条件调 bridge.saveFile，否则浏览器端 bridge 又会调回本函数 → 死循环。
      if (NAME === "capacitor") {
        var fsPlug = plug("Filesystem");
        if (fsPlug && fsPlug.writeFile && bridge && bridge.saveFile) return Promise.resolve(bridge.saveFile(opts));
      }
      return webSaveTextFile(opts);
    },

    // 在文件管理器里定位文件（自动安装未启动时的手动出口）；非桌面端为空实现
    revealFile: function (p) {
      if (NAME === "electron" && w.electronAPI.revealFile) return Promise.resolve(w.electronAPI.revealFile(p));
      return Promise.resolve({ ok: false, error: "unsupported" });
    },

    platformInfo: function () {
      return { name: NAME, userAgent: (w.navigator && w.navigator.userAgent) || "" };
    },

    /* 各端能力开关：业务代码据此决定"按钮显示/是否提示不支持"，不再散落 if (electronAPI) */
    capabilities: {
      pickImage: NAME !== "browser",   // 浏览器暂不支持插图（避免把大图塞进 localStorage）
      saveFile: true,
      share: true,
      update: true,
      revealFile: NAME === "electron",
      webdav: NAME === "electron",
    },

    /* 选图：桌面弹系统对话框（含内嵌/引用两种模式）；移动端拍照/相册并自动压缩；浏览器不支持 */
    pickImage: function (opts) {
      opts = opts || {};
      if (NAME === "electron" && w.electronAPI.pickImage) {
        return Promise.resolve(w.electronAPI.pickImage(opts.mode || "embed"));
      }
      if (NAME === "capacitor") {
        var cam = plug("Camera");
        if (!cam || !cam.getPhoto) return Promise.resolve(null);
        return cam.getPhoto({
          quality: 90,
          resultType: "dataUrl",
          source: opts.source || "photos", // camera | photos
          width: 2000,
          correctOrientation: true,
        }).then(function (photo) {
          if (!photo || !photo.dataUrl) return null;
          return resizeDataUrl(photo.dataUrl, opts.max || 1600);
        }).then(function (d) {
          return d ? { name: "照片-" + Date.now() + ".jpg", dataUrl: d } : null;
        }).catch(function () { return null; });
      }
      return Promise.resolve(null);
    },

    /* 分享文本：移动端用系统分享面板；浏览器用 Web Share（不支持则复制）；桌面端复制到剪贴板 */
    shareText: function (opts) {
      opts = opts || {};
      var text = String(opts.text == null ? "" : opts.text);
      if (NAME === "capacitor") {
        var sh = plug("Share");
        if (sh && sh.share) {
          return Promise.resolve(sh.share({ title: opts.title || "", text: text, dialogTitle: opts.dialogTitle || "分享" }))
            .catch(function () { return api.copyText(text); });
        }
      }
      if (NAME === "browser" && w.navigator && w.navigator.share) {
        return Promise.resolve(w.navigator.share({ title: opts.title || "", text: text }))
          .catch(function () { return api.copyText(text); });
      }
      return Promise.resolve(api.copyText(text));
    },

    /* 导出文本文件：桌面弹保存对话框；移动端写缓存目录后拉起分享/保存；浏览器直接下载 */
    exportText: function (opts) {
      opts = opts || {};
      if (NAME === "electron" && w.electronAPI.saveFile) return Promise.resolve(w.electronAPI.saveFile(opts));
      if (NAME === "capacitor") {
        var fs = plug("Filesystem"), sh = plug("Share");
        var name = String(opts.defaultName || "note.txt");
        if (fs && fs.writeFile) {
          return Promise.resolve(fs.writeFile({
            path: name,
            data: String(opts.content || ""),
            directory: "CACHE",
            encoding: "utf8",
            recursive: true,
          })).then(function (r) {
            var uri = (r && r.uri) || name;
            if (sh && sh.share) {
              return sh.share({ title: opts.title || name, url: uri, dialogTitle: "导出" })
                .then(function () { return { ok: true, path: uri }; });
            }
            return { ok: true, path: uri };
          }).catch(function () { return webSaveTextFile(opts); });
        }
      }
      return webSaveTextFile(opts);
    },

    /* 检查最新版本：桌面走主进程（含托盘/通知等完整流程）；移动端看 mobile-v* 标签；网页版看 v* 标签 */
    checkLatestVersion: function (opts) {
      opts = opts || {};
      var channel = opts.channel || (NAME === "capacitor" ? "mobile" : "desktop");
      if (NAME === "electron" && w.electronAPI.checkUpdate) {
        return Promise.resolve(w.electronAPI.checkUpdate()).then(function (r) {
          return (r && r.ok && r.latest) ? { version: r.latest.version, url: r.latest.url } : null;
        }).catch(function () { return null; });
      }
      var repo = opts.repo || "feibixunchang/easynote";
      var re = channel === "mobile" ? MOBILE_TAG_RE : DESKTOP_TAG_RE;
      return fetchGithubTags(repo).then(function (tags) {
        var v = pickMaxVersion(tags, re);
        if (!v) return null;
        return {
          version: v,
          url: "https://github.com/" + repo + "/releases/tag/" + (channel === "mobile" ? "mobile-v" : "v") + v,
        };
      });
    },
  };

  /* ---------- bridge：与 electronAPI 同形的对象 ----------
   * 业务代码里大量 `api.xxx()` 的写法可以一行切过来：
   *   var api = window.electronAPI || EZPlatform.bridge;
   * Electron 下它就是 electronAPI 的浅拷贝（行为与以前完全一致），
   * 浏览器/移动端则补上 Web / Capacitor 实现。
   * 注意：**不**为浏览器伪造 pickImage / 更新 / WebDAV 等桌面专属能力 ——
   *       保持 undefined，业务代码原有的 `if (!api.xxx)` 守卫逻辑因此不变。 */
  var bridge = {};
  if (NAME === "electron" && w.electronAPI) {
    Object.keys(w.electronAPI).forEach(function (k) { bridge[k] = w.electronAPI[k]; });
  }
  if (NAME === "capacitor") {
    var fs = plug("Filesystem");
    bridge.openExternal = function (url) { api.openExternal(url); };
    bridge.writeClipboard = function (t) { return api.copyText(t); };
    bridge.getClipboardText = function () { return api.readText(); };
    bridge.saveFile = function (opts) {
      // 手机端：写入缓存目录后拉起系统分享/保存（与原有"导出"体验一致）
      if (!fs || !fs.writeFile) return Promise.resolve({ ok: false, error: "unsupported" });
      var name = String((opts && opts.defaultName) || "note.txt");
      return fs.writeFile({ path: name, data: String((opts && opts.content) || ""), directory: "CACHE", encoding: "utf8" })
        .then(function (r) { return { ok: true, path: (r && r.uri) || name }; })
        .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
    };
  }
  if (NAME === "browser") {
    bridge.openExternal = function (url) { api.openExternal(url); };
    bridge.writeClipboard = function (t) { return api.copyText(t); };
    bridge.getClipboardText = function () { return api.readText(); };
    bridge.saveFile = function (opts) { return webSaveTextFile(opts); };
    bridge.revealFile = function () { return Promise.resolve({ ok: false, error: "unsupported" }); };
  }
  // 补齐通用项（不覆盖已有能力）
  if (!bridge.writeClipboard) bridge.writeClipboard = function (t) { return api.copyText(t); };
  if (!bridge.getClipboardText) bridge.getClipboardText = function () { return api.readText(); };
  if (!bridge.openExternal) bridge.openExternal = function (url) { api.openExternal(url); };
  if (!bridge.saveFile) bridge.saveFile = function (opts) { return webSaveTextFile(opts); };

  api.bridge = bridge;
  root.EZPlatform = api;
})(typeof window !== "undefined" ? window : this);
