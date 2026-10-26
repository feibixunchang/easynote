/* 生成 iOS / Android 图标与启动图（纯 JS，无需 sharp）
 * 用法：npm i --no-save pngjs && node tools/gen-icons.js
 *       （pngjs 未列入 package.json 依赖，运行时临时装即可）
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
// 缩放：缩小走面积平均（box filter，先低通再采样，避免锯齿），放大走双线性。
// 全程按预乘 alpha 计算，否则透明边缘的颜色会渗进邻域、描边发暗。
function resize(src, w, h) {
  const dst = new PNG({ width: w, height: h });
  const xr = src.width / w, yr = src.height / h;
  const sw = src.width, sh = src.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      if (xr > 1 || yr > 1) {
        const sy0 = y * yr, sy1 = (y + 1) * yr;
        const sx0 = x * xr, sx1 = (x + 1) * xr;
        let r = 0, g = 0, b = 0, a = 0, wt = 0;
        for (let sy = Math.floor(sy0); sy < Math.min(sh, Math.ceil(sy1)); sy++) {
          const fy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
          if (fy <= 0) continue;
          for (let sx = Math.floor(sx0); sx < Math.min(sw, Math.ceil(sx1)); sx++) {
            const fx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
            if (fx <= 0) continue;
            const wgt = fx * fy;
            const i = (sy * sw + sx) * 4;
            const al = src.data[i + 3] / 255;
            r += src.data[i] * al * wgt;
            g += src.data[i + 1] * al * wgt;
            b += src.data[i + 2] * al * wgt;
            a += al * wgt;
            wt += wgt;
          }
        }
        if (a > 0) {
          dst.data[di] = Math.round(r / a);
          dst.data[di + 1] = Math.round(g / a);
          dst.data[di + 2] = Math.round(b / a);
          dst.data[di + 3] = Math.round(a / wt * 255);
        }
        continue;
      }
      // 放大：双线性
      const sx = (x + 0.5) * xr - 0.5, sy = (y + 0.5) * yr - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
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
// 启动图：纯色底 + 居中的图形本体（透明底笔记本）。
// 旧做法把整张图标（含圆角蓝底 + 透明角）贴上去，圆角轮廓与纯色背景有色差，
// 启动画面里会出现一个"方块浮在背景上"的痕迹。
function makeSplash(w, h, art, box, bg, ratio) {
  const s = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    s.data[i * 4] = bg.r; s.data[i * 4 + 1] = bg.g;
    s.data[i * 4 + 2] = bg.b; s.data[i * 4 + 3] = 255;
  }
  const side = Math.min(w, h);
  const layer = fgCanvas(art, box, side, ratio);
  const ox = Math.round((w - side) / 2), oy = Math.round((h - side) / 2);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const si = (y * side + x) * 4;
      const a = layer.data[si + 3] / 255;
      if (a <= 0) continue;
      const di = ((y + oy) * w + (x + ox)) * 4;
      for (let c = 0; c < 3; c++) {
        s.data[di + c] = Math.round(layer.data[si + c] * a + s.data[di + c] * (1 - a));
      }
    }
  }
  return s;
}

/* iOS App Icon 必须【满幅不透明】方形——圆角由系统自己裁。
 * 源图标是带透明圆角的方形（macOS/Windows 桌面端需要圆角），若直接拿来当 iOS 图标：
 * 收起 App 的动画里，缩小中的卡片盖住图标上半部，露出的下方两角会透出白底，
 * 表现为"图标下面两个角有白色边角"。这里把透明角用邻近的蓝色渐变铺满，并去掉 alpha 通道。*/
function flattenOpaque(src) {
  const w = src.width, h = src.height;
  const dst = new PNG({ width: w, height: h });
  src.data.copy(dst.data);
  const cx = w >> 1, cy = h >> 1;
  let filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (dst.data[i + 3] > 250) continue;
      const dx = x < cx ? 1 : (x > cx ? -1 : 0);
      const dy = y < cy ? 1 : (y > cy ? -1 : 0);
      let nx = x, ny = y;
      for (let k = 0; k < 256; k++) {
        nx += dx; ny += dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
        const j = (ny * w + nx) * 4;
        if (dst.data[j + 3] > 250) {
          dst.data[i] = dst.data[j];
          dst.data[i + 1] = dst.data[j + 1];
          dst.data[i + 2] = dst.data[j + 2];
          dst.data[i + 3] = 255;
          filled++;
          break;
        }
      }
    }
  }
  for (let i = 3; i < dst.data.length; i += 4) dst.data[i] = 255;
  console.log("iOS 图标：铺满透明角", filled, "像素（已转为不透明）");
  return dst;
}
// 输出不带 alpha 通道（colorType 2 = RGB）——带 alpha 的图标会被 App Store 拒收
function writePngRGB(p, png) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PNG.sync.write(png, { colorType: 2 }));
}
// 居中放大（先裁掉边缘再放大回原尺寸）：让笔记本在图标里更饱满。
// 背景是平滑蓝色渐变，放大 18% 看不出接缝。
const IOS_ICON_ZOOM = 1.18;
function zoomCenter(src, z) {
  const w = src.width, h = src.height;
  const cw = Math.round(w / z), ch = Math.round(h / z);
  const ox = Math.round((w - cw) / 2), oy = Math.round((h - ch) / 2);
  const cropped = new PNG({ width: cw, height: ch });
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y + oy) * w + (x + ox)) * 4;
      const di = (y * cw + x) * 4;
      cropped.data[di] = src.data[si];
      cropped.data[di + 1] = src.data[si + 1];
      cropped.data[di + 2] = src.data[si + 2];
      cropped.data[di + 3] = src.data[si + 3];
    }
  }
  return resize(cropped, w, h);
}

/* Android 自适应图标（API 26+）：
 * foreground 只放"图形本体"（透明底），蓝色背景交给 background 图层；
 * 可见区是 108dp 画布中心 72dp，圆形遮罩后约 66dp。
 * 旧做法把整张（含蓝色圆角背景的）图标塞进 foreground —— 笔记本被缩小一圈，
 * 外面还多套一层同色蓝块，与 iOS 观感不一致。 */
const AND_FG_RATIO = 0.5; // 笔记本高度占 108dp 画布的比例：72dp 可见圆内 0 裁切，且留白舒服

// 源图标是纯垂直渐变：同一行左右同色。取每行两侧（避开笔记本）的中位色
function rowBg(icon) {
  const w = icon.width, h = icon.height, rows = [];
  const med = function (a) {
    if (!a.length) return 0;
    a.sort(function (p, q) { return p - q; });
    return a[a.length >> 1];
  };
  for (let y = 0; y < h; y++) {
    const rs = [], gs = [], bs = [];
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (icon.data[i + 3] < 200) continue;
      if (x > 280 && x < 745) continue; // 笔记本区域，跳过
      rs.push(icon.data[i]); gs.push(icon.data[i + 1]); bs.push(icon.data[i + 2]);
    }
    rows.push(rs.length
      ? [med(rs), med(gs), med(bs)]
      : (rows[rows.length - 1] || [74, 145, 231]));
  }
  return rows;
}

// 按"与该行背景色的距离"把蓝色背景剔除为透明，得到图形本体（笔记本）
function extractArtwork(icon) {
  const w = icon.width, h = icon.height;
  const bg = rowBg(icon);
  const dst = new PNG({ width: w, height: h });
  const LO = 12, HI = 42; // 距离 <LO 判为背景（全透明），>HI 全不透明，中间按比例过渡
  for (let y = 0; y < h; y++) {
    const b = bg[y];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (icon.data[i + 3] < 200) continue; // 源图透明角：跳过，否则会被算成"实体"
      const r = icon.data[i], g = icon.data[i + 1], bl = icon.data[i + 2];
      const d = Math.sqrt((r - b[0]) * (r - b[0]) + (g - b[1]) * (g - b[1]) + (bl - b[2]) * (bl - b[2]));
      let a = (d - LO) / (HI - LO);
      a = a < 0 ? 0 : (a > 1 ? 1 : a);
      if (a <= 0) continue;
      // 半透明边缘反解掉背景混色，否则描边会发蓝
      const un = function (c, bc) {
        const v = (c - bc * (1 - a)) / a;
        return v < 0 ? 0 : (v > 255 ? 255 : Math.round(v));
      };
      dst.data[i] = un(r, b[0]);
      dst.data[i + 1] = un(g, b[1]);
      dst.data[i + 2] = un(bl, b[2]);
      dst.data[i + 3] = Math.round(a * 255);
    }
  }
  bleedColor(dst);
  return dst;
}

// 透明像素填上同行的图形颜色（alpha 仍为 0）：缩放时双线性采样不会把边缘拉暗
function bleedColor(png) {
  const w = png.width, h = png.height;
  for (let y = 0; y < h; y++) {
    let last = null;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (png.data[i + 3] > 0) { last = [png.data[i], png.data[i + 1], png.data[i + 2]]; break; }
    }
    if (!last) continue;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (png.data[i + 3] > 0) {
        last = [png.data[i], png.data[i + 1], png.data[i + 2]];
      } else {
        png.data[i] = last[0]; png.data[i + 1] = last[1]; png.data[i + 2] = last[2];
      }
    }
  }
}

function bboxOf(png) {
  let x0 = png.width, y0 = png.height, x1 = -1, y1 = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0: x0, y0: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 图形本体按"高度占画布 ratio"缩放并居中，放进 size×size 的自适应图标前景画布
function fgCanvas(art, box, size, ratio) {
  const th = Math.max(1, Math.round(size * ratio));
  const tw = Math.max(1, Math.round(th * box.w / box.h));
  const crop = new PNG({ width: box.w, height: box.h });
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const si = ((y + box.y0) * art.width + (x + box.x0)) * 4;
      const di = (y * box.w + x) * 4;
      crop.data[di] = art.data[si];
      crop.data[di + 1] = art.data[si + 1];
      crop.data[di + 2] = art.data[si + 2];
      crop.data[di + 3] = art.data[si + 3];
    }
  }
  const scaled = resize(crop, tw, th);
  const out = new PNG({ width: size, height: size });
  out.data.fill(0);
  const ox = Math.round((size - tw) / 2), oy = Math.round((size - th) / 2);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const si = (y * tw + x) * 4;
      const di = ((y + oy) * size + (x + ox)) * 4;
      out.data[di] = scaled.data[si];
      out.data[di + 1] = scaled.data[si + 1];
      out.data[di + 2] = scaled.data[si + 2];
      out.data[di + 3] = scaled.data[si + 3];
    }
  }
  return out;
}

function writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
}

/* ---------- 主流程 ---------- */
const icon = readPng(SRC);
const bg = brandColor(icon);
console.log("源图标:", icon.width + "x" + icon.height, "| 品牌色:", hex(bg));

// 图形本体（白色笔记本，透明底）：自适应图标前景与启动图都用它
const artwork = extractArtwork(icon);
const artBox = bboxOf(artwork);

// 0) 资源源文件入档（方便以后重新生成）
writePng(path.join(RES_DIR, "icon-1024.png"), icon);
writePng(path.join(RES_DIR, "splash-2732.png"), makeSplash(2732, 2732, artwork, artBox, bg, 0.25));

// 1) Android 传统图标（API < 26）：与 iOS 同款——满幅不透明 + 笔记本放大 1.18。
//    旧版直接拿带透明圆角的源图，部分 launcher / 系统界面会把透明角合成白底。
const brandIcon = flattenOpaque(zoomCenter(icon, IOS_ICON_ZOOM));
const legacy = { "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192 };
Object.keys(legacy).forEach(function (d) {
  const img = resize(brandIcon, legacy[d], legacy[d]);
  writePng(path.join(AND_RES, "mipmap-" + d, "ic_launcher.png"), img);
  writePng(path.join(AND_RES, "mipmap-" + d, "ic_launcher_round.png"), img);
});

// 2) Android 自适应图标前景（108/162/216/324/432）：只放笔记本，透明底
console.log("Android 前景：笔记本", artBox.w + "x" + artBox.h, "→ 占画布", AND_FG_RATIO * 100 + "%");
const fg = { "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432 };
Object.keys(fg).forEach(function (d) {
  writePng(path.join(AND_RES, "mipmap-" + d, "ic_launcher_foreground.png"),
    fgCanvas(artwork, artBox, fg[d], AND_FG_RATIO));
});

// 3) 自适应图标背景：矢量线性渐变（任意密度都清晰），取源图上下边缘的蓝色
const bgRows = rowBg(icon);
const bgTop = bgRows[180] || [bg.r, bg.g, bg.b];
const bgBottom = bgRows[843] || [bg.r, bg.g, bg.b];
const hexArr = function (a) { return hex({ r: a[0], g: a[1], b: a[2] }); };
writeText(path.join(AND_RES, "drawable", "ic_launcher_background.xml"),
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n' +
  '    <gradient\n' +
  '        android:type="linear"\n' +
  '        android:angle="270"\n' +
  '        android:startColor="' + hexArr(bgTop).toUpperCase() + '"\n' +
  '        android:endColor="' + hexArr(bgBottom).toUpperCase() + '" />\n' +
  '</shape>\n');
["ic_launcher.xml", "ic_launcher_round.xml"].forEach(function (f) {
  writeText(path.join(AND_RES, "mipmap-anydpi-v26", f),
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@drawable/ic_launcher_background"/>\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
    '</adaptive-icon>\n');
});
console.log("Android 自适应背景渐变:", hexArr(bgTop), "→", hexArr(bgBottom));

// 3b) 纯色兜底（部分 ROM / 工具链会引用 @color/ic_launcher_background）
const bgXml = path.join(AND_RES, "values", "ic_launcher_background.xml");
if (fs.existsSync(bgXml)) {
  fs.writeFileSync(bgXml,
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' +
    '    <color name="ic_launcher_background">' + hex(bg).toUpperCase() + '</color>\n' +
    '</resources>\n');
  console.log("已更新 ic_launcher_background 颜色:", hex(bg));
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
  writePng(p, makeSplash(old.width, old.height, artwork, artBox, bg, 0.21));
  splashCount++;
});
console.log("Android 启动图:", splashCount, "张");

// 5) iOS AppIcon（单 1024 通用图标）：居中放大让笔记本更饱满 + 满幅不透明 + 无 alpha 通道
writePngRGB(path.join(IOS_ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png"),
  flattenOpaque(zoomCenter(icon, IOS_ICON_ZOOM)));

// 6) iOS 启动图（imageset 指定的三张 2732x2732）
const splashSet = path.join(IOS_ASSETS, "Splash.imageset");
if (fs.existsSync(splashSet)) {
  const sp = makeSplash(2732, 2732, artwork, artBox, bg, 0.25);
  ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"].forEach(function (f) {
    writePng(path.join(splashSet, f), sp);
  });
  console.log("iOS 启动图: 3 张 (2732x2732)");
}

console.log("全部图标 / 启动图生成完成 ✅");
