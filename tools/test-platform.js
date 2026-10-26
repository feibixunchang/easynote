#!/usr/bin/env node
/* ============================================================
 * 平台适配层单元测试（shared/platform.js）
 * ------------------------------------------------------------
 * 用三个"假环境"分别验证三种端的适配是否各就各位：
 *   ① 桌面（window.electronAPI）
 *   ② 移动（window.Capacitor 插件）
 *   ③ 浏览器（Web API 兜底）
 * 这三条路一旦接错，就会出现"点了复制没反应 / 链接打不开"这类端差异 bug。
 *
 * 用法：node tools/test-platform.js
 * ============================================================ */
"use strict";

const path = require("path");
const PLATFORM = path.join(__dirname, "..", "shared", "platform.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

// 每个用例前重置：清 require 缓存 + 造一个干净的 window
function loadWith(win) {
  delete require.cache[require.resolve(PLATFORM)];
  global.window = win;
  require(PLATFORM);
  return global.window.EZPlatform;
}

(async function () {
  console.log("\n【1】浏览器环境（Web API 兜底）");
  {
    const calls = [];
    const win = {
      open: function (u) { calls.push(u); return {}; },
      navigator: { clipboard: { writeText: function (t) { calls.push("copy:" + t); return Promise.resolve(); },
                                readText: function () { return Promise.resolve("clip"); } } },
      document: {
        createElement: function () { return { style: {}, setAttribute: function () {}, click: function () { calls.push("download-click"); }, remove: function () {} }; },
        body: { appendChild: function () {}, removeChild: function () {} },
        execCommand: function () { return true; },
      },
      Blob: function (parts) { this.parts = parts; },
      URL: { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} },
      setTimeout: setTimeout,
      console: console,
    };
    const EZ = loadWith(win);
    ok("识别为 browser", EZ.name === "browser", EZ.name);
    EZ.openExternal("https://example.com/a");
    ok("openExternal → window.open", calls.indexOf("https://example.com/a") !== -1);
    await EZ.copyText("你好");
    ok("copyText → navigator.clipboard", calls.indexOf("copy:你好") !== -1);
    ok("readText → navigator.clipboard", (await EZ.readText()) === "clip");
    const r = await EZ.saveTextFile({ defaultName: "a.md", content: "x" });
    ok("saveTextFile → 浏览器下载", r && r.ok && calls.indexOf("download-click") !== -1, JSON.stringify(r));
    ok("bridge 与 electronAPI 同形（供 app.js 一行切换）",
      typeof EZ.bridge.openExternal === "function" && typeof EZ.bridge.saveFile === "function");
    ok("浏览器不伪造桌面专属能力 pickImage", typeof EZ.bridge.pickImage === "undefined");
  }

  console.log("\n【2】桌面端环境（electronAPI）");
  {
    const calls = [];
    const win = {
      navigator: { userAgent: "Electron/31" },
      electronAPI: {
        openExternal: function (u) { calls.push("ext:" + u); },
        writeClipboard: function (t) { calls.push("wc:" + t); return true; },
        getClipboardText: function () { return "from-electron"; },
        saveFile: function (o) { calls.push("save:" + (o && o.defaultName)); return Promise.resolve({ ok: true }); },
        pickImage: function () { return Promise.resolve(null); },
        someElectronOnlyThing: function () { return 42; },
      },
      console: console,
    };
    const EZ = loadWith(win);
    ok("识别为 electron", EZ.name === "electron", EZ.name);
    EZ.openExternal("https://a.b");
    ok("openExternal → electronAPI（行为与以前一致）", calls.indexOf("ext:https://a.b") !== -1);
    await EZ.copyText("t");
    ok("copyText → electronAPI.writeClipboard", calls.indexOf("wc:t") !== -1);
    ok("readText → electronAPI.getClipboardText", (await EZ.readText()) === "from-electron");
    const r2 = await EZ.saveTextFile({ defaultName: "n.md" });
    ok("saveTextFile → electronAPI.saveFile", r2 && r2.ok && calls.indexOf("save:n.md") !== -1);
    ok("bridge 透传 electronAPI 全部方法（桌面功能不受影响）",
      typeof EZ.bridge.pickImage === "function" && EZ.bridge.someElectronOnlyThing() === 42);
  }

  console.log("\n【3】移动端环境（Capacitor 插件）");
  {
    const calls = [];
    const win = {
      navigator: { userAgent: "iPhone" },
      Capacitor: {
        isNativePlatform: function () { return true; },
        getPlatform: function () { return "ios"; },
        Plugins: {
          Browser: { open: function (o) { calls.push("browser:" + o.url); return Promise.resolve(); } },
          Clipboard: { writeText: function (o) { calls.push("clip:" + o.string); return Promise.resolve(); },
                       read: function () { return Promise.resolve({ value: "cap-clip" }); } },
          Filesystem: { writeFile: function (o) { calls.push("fs:" + o.path); return Promise.resolve({ uri: "file:///x/" + o.path }); } },
        },
      },
      console: console,
    };
    const EZ = loadWith(win);
    ok("识别为 capacitor", EZ.name === "capacitor", EZ.name);
    EZ.openExternal("https://m.example");
    ok("openExternal → Browser 插件", calls.indexOf("browser:https://m.example") !== -1);
    await EZ.copyText("手机文本");
    ok("copyText → Clipboard 插件", calls.indexOf("clip:手机文本") !== -1);
    ok("readText → Clipboard.read", (await EZ.readText()) === "cap-clip");
    const r3 = await EZ.saveTextFile({ defaultName: "m.md", content: "x" });
    ok("saveTextFile → Filesystem 写缓存", r3 && r3.ok && calls.indexOf("fs:m.md") !== -1, JSON.stringify(r3));
    ok("移动端不伪造桌面专属能力（更新/pickImage）",
      typeof EZ.bridge.pickImage === "undefined" && typeof EZ.bridge.startUpdate === "undefined");
  }

  console.log("\n【4】能力开关 + 选图 / 分享 / 导出 / 更新检查");
  {
    // —— 浏览器：不支持选图，分享回退复制，导出走下载，更新检查看 v* 标签 ——
    const calls = [];
    const win = {
      setTimeout: setTimeout, clearTimeout: clearTimeout, console: console,
      navigator: { clipboard: { writeText: (t) => { calls.push("copy:" + t); return Promise.resolve(); } } },
      open: function () {},
      document: { createElement: () => ({ style: {}, setAttribute(){}, click(){ calls.push("download"); }, remove(){} }),
                  body: { appendChild(){}, removeChild(){} }, execCommand: () => true },
      Blob: function () {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL(){} },
      fetch: function (url) {
        calls.push("fetch:" + url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve([
          { tag_name: "v1.2.30" }, { tag_name: "mobile-v1.0.21" }, { tag_name: "v1.2.9" }, { tag_name: "v1.3.0" },
        ]) });
      },
    };
    const EZ = loadWith(win);
    ok("浏览器：不支持选图", EZ.capabilities.pickImage === false);
    ok("浏览器：支持导出（下载）", EZ.capabilities.saveFile === true);
    ok("浏览器：没有桌面专属能力（revealFile/webdav）",
      EZ.capabilities.revealFile === false && EZ.capabilities.webdav === false);
    await EZ.shareText({ title: "t", text: "分享文本" });
    ok("浏览器没有 Web Share 时回退复制", calls.indexOf("copy:分享文本") !== -1);
    const info = await EZ.checkLatestVersion({ channel: "desktop" });
    ok("网页版更新检查只看 v* 标签并取最大版本", info && info.version === "1.3.0", JSON.stringify(info));
    ok("更新链接指向对应 release tag", info && info.url.indexOf("/releases/tag/v1.3.0") !== -1);
    const infoM = await EZ.checkLatestVersion({ channel: "mobile" });
    ok("移动端更新检查只看 mobile-v* 标签", infoM && infoM.version === "1.0.21", JSON.stringify(infoM));
  }

  console.log("\n【5】移动端：选图 / 导出 / 分享 走 Capacitor 插件");
  {
    const calls = [];
    const win = {
      setTimeout: setTimeout, clearTimeout: clearTimeout, console: console,
      navigator: { userAgent: "iPhone" },
      // 简易 Image 桩：设置 src 后立刻回调 onload（尺寸很小 → 压缩逻辑原样返回）
      Image: function () {
        const self = this;
        Object.defineProperty(self, "src", { set: function () {
          setTimeout(function () { self.naturalWidth = 10; self.naturalHeight = 10; if (self.onload) self.onload(); }, 0);
        } });
      },
      document: { createElement: () => ({ getContext: () => ({ drawImage(){} }), toDataURL: () => "data:image/jpeg;base64,SMALL" }) },
      Capacitor: {
        isNativePlatform: () => true, getPlatform: () => "ios",
        Plugins: {
          Camera: { getPhoto: function (o) { calls.push("camera:" + o.source); return Promise.resolve({ dataUrl: "data:image/jpeg;base64,BBB" }); } },
          Filesystem: { writeFile: function (o) { calls.push("fs:" + o.path); return Promise.resolve({ uri: "file:///cache/" + o.path }); } },
          Share: { share: function (o) { calls.push("share:" + (o.url || o.text)); return Promise.resolve(); } },
        },
      },
    };
    const EZ = loadWith(win);
    ok("移动端：支持选图", EZ.capabilities.pickImage === true);
    const img = await EZ.pickImage({ source: "camera" });
    ok("选图 → Camera 插件（拍照来源正确）", calls.indexOf("camera:camera") !== -1);
    ok("选图返回内嵌 dataUrl 与文件名", !!(img && img.dataUrl && img.name), JSON.stringify(img && img.name));
    const r = await EZ.exportText({ defaultName: "b.json", content: "{}" });
    ok("导出 → 写缓存目录 + 拉起系统分享", calls.indexOf("fs:b.json") !== -1 && calls.some((c) => String(c).indexOf("share:") === 0), JSON.stringify(calls.slice(-2)));
    ok("导出返回 ok", r && r.ok === true);
    await EZ.shareText({ title: "笔记", text: "内容" });
    ok("分享 → Share 插件", calls.some((c) => c === "share:内容"));
  }


  console.log("\n────────────────────────");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail ? 1 : 0);
})();
