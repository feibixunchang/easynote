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
