/* 生成 iOS / Android 图标与启动图（纯 JS，无需 sharp）
 * 用法：node tools/gen-icons.js
 * 来源：桌面端图标 build/icons/1024x1024.png（蓝底白笔记本）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "..", "build", "icons", "1024x1024.png");
const AND_RES = path.join(ROOT, "android", "app", "src", "main", "res");
const IOS_ASSETS = path.join(ROOT, "ios", "App", "App", "Assets.xcassets");
const RES_DIR = path.join(ROOT, "resources");

/* ---------- 工具 ---------- */
function readPng(p) { return PNG.sync.read(fs.readFileSync(p)); }
function writePng(p, png) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PNG.sync.write(png));
}
// 双线性缩放
function resize(src, w, h) {
  const dst = new PNG({ width: w, height: h });
  const xr = src.width / w, yr = src.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * xr - 0.5, sy = (y + 0.5) * yr - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
      const i00 = (y0 * src.width + x0) * 4, i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4, i11 = (y1 * src.width + x1) * 4;
      const di = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = src.data[i00 + c] * (1 - fx) * (1 - fy) + src.data[i10 + c] * fx * (1 - fy) +
          src.data[i01 + c] * (1 - fx) * fy + src.data[i11 + c] * fx * fy;
        dst.data[di + c] = Math.round(v);
      }
    }
  }
  return dst;
}
// 品牌色：取图标边缘若干点众数（避开圆角透明区与中央白色笔记）
function brandColor(icon) {
  const pts = [[512, 100], [100, 512], [924, 512], [512, 924]];
  const cnt = {};
  pts.forEach(function (p) {
    const i = (p[1] * icon.width + p[0]) * 4;
    if (icon.data[i + 3] < 200) return;
    const key = icon.data[i] + "," + icon.data[i + 1] + "," + icon.data[i + 2];
    cnt[key] = (cnt[key] || 0) + 1;
  });
  let best = null, n = 0;
  Object.keys(cnt).forEach(function (k) { if (cnt[k] > n) { n = cnt[k]; best = k; } });
  const c = (best || "74,144,226").split(",");
  return { r: +c[0], g: +c[1], b: +c[2] };
}
function hex(c) {
  const h = function (v) { const s = v.toString(16); return s.length < 2 ? "0" + s : s; };
  return "#" + h(c.r) + h(c.g) + h(c.b);
}
// 启动图：纯色底 + 居中图标
function makeSplash(w, h, icon, bg, ratio) {
  const s = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    s.data[i * 4] = bg.r; s.data[i * 4 + 1] = bg.g;
    s.data[i * 4 + 2] = bg.b; s.data[i * 4 + 3] = 255;
  }
  const size = Math.max(1, Math.round(Math.min(w, h) * ratio));
  const ic = resize(icon, size, size);
  const ox = Math.round((w - size) / 2), oy = Math.round((h - size) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      const di = ((y + oy) * w + (x + ox)) * 4;
      const a = ic.data[si + 3] / 255;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) {
        s.data[di + c] = Math.round(ic.data[si + c] * a + s.data[di + c] * (1 - a));
      }
    }
  }
  return s;
}

/* ---------- 主流程 ---------- */
const icon = readPng(SRC);
const bg = brandColor(icon);
console.log("源图标:", icon.width + "x" + icon.height, "| 品牌色:", hex(bg));

// 0) 资源源文件入档（方便以后重新生成）
writePng(path.join(RES_DIR, "icon-1024.png"), icon);
writePng(path.join(RES_DIR, "splash-2732.png"), makeSplash(2732, 2732, icon, bg, 0.4));

// 1) Android 传统图标（ic_launcher / ic_launcher_round）
const legacy = { "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192 };
Object.keys(legacy).forEach(function (d) {
  const img = resize(icon, legacy[d], legacy[d]);
  writePng(path.join(AND_RES, "mipmap-" + d, "ic_launcher.png"), img);
  writePng(path.join(AND_RES, "mipmap-" + d, "ic_launcher_round.png"), img);
});

// 2) Android 自适应图标前景（108/162/216/324/432，与 anydpi-v26 xml 配套）
const fg = { "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432 };
Object.keys(fg).forEach(function (d) {
  writePng(path.join(AND_RES, "mipmap-" + d, "ic_launcher_foreground.png"), resize(icon, fg[d], fg[d]));
});

// 3) Android 自适应图标背景色
const bgXml = path.join(AND_RES, "values", "ic_launcher_background.xml");
if (fs.existsSync(bgXml)) {
  fs.writeFileSync(bgXml,
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' +
    '    <color name="ic_launcher_background">' + hex(bg).toUpperCase() + '</color>\n' +
    '</resources>\n');
  console.log("已更新 ic_launcher_background:", hex(bg));
}

// 4) Android 启动图：按各密度目录里现有 splash.png 的尺寸重新生成（保持模板尺寸）
const splashDirs = ["drawable", "drawable-port-mdpi", "drawable-port-hdpi", "drawable-port-xhdpi",
  "drawable-port-xxhdpi", "drawable-port-xxxhdpi", "drawable-land-mdpi", "drawable-land-hdpi",
  "drawable-land-xhdpi", "drawable-land-xxhdpi", "drawable-land-xxxhdpi"];
let splashCount = 0;
splashDirs.forEach(function (d) {
  const p = path.join(AND_RES, d, "splash.png");
  if (!fs.existsSync(p)) return;
  const old = readPng(p);
  writePng(p, makeSplash(old.width, old.height, icon, bg, 0.34));
  splashCount++;
});
console.log("Android 启动图:", splashCount, "张");

// 5) iOS AppIcon（单 1024 通用图标）
writePng(path.join(IOS_ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png"), icon);

// 6) iOS 启动图（imageset 指定的三张 2732x2732）
const splashSet = path.join(IOS_ASSETS, "Splash.imageset");
if (fs.existsSync(splashSet)) {
  const sp = makeSplash(2732, 2732, icon, bg, 0.4);
  ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"].forEach(function (f) {
    writePng(path.join(splashSet, f), sp);
  });
  console.log("iOS 启动图: 3 张 (2732x2732)");
}

console.log("全部图标 / 启动图生成完成 ✅");
