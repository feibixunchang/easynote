/* ============ Electron 主进程 ============ */
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, Notification, nativeTheme, clipboard, protocol } = require("electron");
const path = require("path");
const fs = require("fs");
const { execSync, execFile } = require("child_process");

const APP_VERSION = app.getVersion();
const REPO_OWNER = "feibixunchang";
const REPO_NAME = "easynote";

// 主题色：与界面 CSS 变量保持一致（浅色 #f7f7f7 侧栏 / 深色 #252525）
// 标题栏用编辑器背景色，视觉上与主界面连成一体
const THEME_COLORS = {
  light: { bg: "#ffffff", fg: "#333333" },
  dark: { bg: "#1e1e1e", fg: "#e2e2e2" },
};

// 枚举本机已安装字体（按平台分别实现）
function getSystemFonts() {
  try {
    if (process.platform === "win32") return getWindowsFonts();
    if (process.platform === "darwin") return getMacFonts();
    return getLinuxFonts();
  } catch (e) {
    return [];
  }
}
function getWindowsFonts() {
  const out = execSync(
    'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts" /s',
    { encoding: "utf8", windowsHide: true }
  );
  const names = new Set();
  out.split("\n").forEach(function (line) {
    const m = line.match(/(.+?)\s+REG_SZ\s+\S/);
    if (m) {
      let name = m[1]
        .replace(/\s*\((TrueType|OpenType|OpenType CFF|Type 1)\)\s*$/i, "")
        .trim();
      if (name) names.add(name);
    }
  });
  return [...names].sort();
}
function getMacFonts() {
  // macOS：system_profiler 输出所有字体族（可能耗时几秒）
  const out = execSync("system_profiler SPFontsDataType -json", {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const data = JSON.parse(out);
  const names = new Set();
  (data.SPFontsDataType || []).forEach(function (entry) {
    if (entry.family) names.add(String(entry.family).trim());
    (entry.typefaces || []).forEach(function (t) {
      if (t.family) names.add(String(t.family).trim());
    });
  });
  return [...names].filter(Boolean).sort();
}
function getLinuxFonts() {
  // Linux：fontconfig 列出字体族名（fc-list 属于 fontconfig 包，桌面环境必装）
  const out = execSync("fc-list : family", { encoding: "utf8", timeout: 15000 });
  const names = new Set();
  out.split("\n").forEach(function (line) {
    // 一行可能含多个字体族（逗号分隔）
    line.split(",").forEach(function (f) {
      f = f.trim();
      if (f) names.add(f);
    });
  });
  return [...names].sort();
}

ipcMain.handle("get-system-fonts", function () {
  return getSystemFonts();
});

/* ============ 标题栏与主界面一体色 ============ */
// Windows / Linux：隐藏系统标题栏 + 原生窗口按钮覆盖层（颜色随主题）
// macOS：隐藏标题栏保留交通灯，背景色随主题
function applyTitlebarTheme(win, dark) {
  const c = dark ? THEME_COLORS.dark : THEME_COLORS.light;
  if (process.platform === "darwin") {
    win.setBackgroundColor(c.bg);
  } else if (typeof win.setTitleBarOverlay === "function") {
    win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg });
  }
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const c = dark ? THEME_COLORS.dark : THEME_COLORS.light;
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: c.bg,
    title: "简易笔记",
    // 隐藏系统标题栏，让标题区域与主界面同色：
    // Win/Linux 用原生窗口按钮覆盖层，macOS 保留左上角交通灯
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? {}
      : { titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: 34 } }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
  applyTitlebarTheme(win, dark);

  // 关闭窗口时隐藏到托盘（托盘菜单里可真正退出）
  win.on("close", function (e) {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
      return false;
    }
  });

  return win;
}

/* ============ 托盘图标 ============ */
let tray = null;
let mainWindow = null;

function getTrayIcon() {
  // 纯白笔记本样式托盘图标：macOS 用「模板图」机制，菜单栏里自动显示为单色
  // （深色菜单栏→白色，浅色→深色），与其它系统托盘图标一致、美观。
  // 图标本身是白色形状 + 透明底；模板图只取 alpha 通道，颜色被忽略。
  const trayPath = path.join(__dirname, "build/icons/tray-mac.png");
  try {
    const buf = fs.readFileSync(trayPath); // fs 透明支持 asar
    let img = nativeImage.createFromBuffer(buf);
    if (img && !img.isEmpty()) {
      img.setTemplateImage(true); // 关键：模板图 → 菜单栏里显示为标准单色图标
      const s = img.getSize();
      // 菜单栏图标应约为 18pt 高；过大就缩放，避免在菜单栏里拉成一条长横条
      if (s.height > 20) img = img.resize({ height: 18, quality: "best" });
      return img;
    }
  } catch (e) {
    /* 回退到通用图标 */
  }
  // 回退：复用原 app 图标（同样作为模板图），避免菜单栏出现空白长条
  const candidates = [
    path.join(__dirname, "build/icons/256x256.png"),
    path.join(__dirname, "build/icons/128x128.png"),
    path.join(__dirname, "build/icon.png"),
  ];
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(p); // fs 透明支持 asar
      let img = nativeImage.createFromBuffer(buf);
      if (img && !img.isEmpty()) {
        img.setTemplateImage(true);
        const s = img.getSize();
        if (s.height > 20) img = img.resize({ height: 18, quality: "best" });
        return img;
      }
    } catch (e) {
      /* 尝试下一个候选 */
    }
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const hasUpdate =
    latestRelease && compareVersions(latestRelease.version, APP_VERSION) > 0;
  const template = [
    {
      label: "显示主窗口",
      click: function () {
        showWindow();
      },
    },
    {
      label: "新建笔记",
      click: function () {
        showWindow();
        if (mainWindow) mainWindow.webContents.send("menu-new-note");
      },
    },
    { type: "separator" },
    hasUpdate
      ? {
          label: "⬆ 下载新版本 v" + latestRelease.version,
          click: function () {
            shell.openExternal(latestRelease.url);
          },
        }
      : { label: "检查更新…", click: function () { checkUpdate(true); } },
    { type: "separator" },
    { label: "简易笔记 v" + APP_VERSION, enabled: false },
    { label: "关于", click: showAbout },
    { type: "separator" },
    {
      label: "退出",
      click: function () {
        app.isQuitting = true;
        app.quit();
      },
    },
  ];
  return Menu.buildFromTemplate(template);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(getTrayIcon());
  if (process.platform === "darwin") tray.setTitle(""); // 菜单栏只显示图标、不显示文字标题
  tray.setToolTip("简易笔记 v" + APP_VERSION);
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", toggleWindow);
  tray.on("double-click", toggleWindow);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    buildMenu(mainWindow);
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

/* ============ 版本号 / 更新检查 ============ */
let latestRelease = null; // { version, url }
let updateTimer = null;

// 更新检查调度：成功后 6 小时再查；失败 10 分钟后重试（国内网络首次查不到时不会干等 6 小时）
function scheduleUpdateCheck(delayMs) {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(function () {
    checkUpdate(false);
  }, delayMs);
}

// 带超时的 fetch：网络挂起时不会无限等待（Electron 主进程可用 AbortController）
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 12000);
  return fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "easynote-update-check" },
    signal: ctrl.signal,
  }).finally(function () { clearTimeout(timer); });
}

// 多渠道探测最新版本号（任一成功即返回 "x.y.z" 字符串）：
//  ① api.github.com REST 接口：信息最全，但未认证限额 60 次/小时/IP，
//     共用出口 IP（公司网络/代理）容易被限流返回 403；
//  ② github.com 的 /releases/latest 页面：302 重定向到最新 tag 的页面，
//     走 web 节点、限额宽得多，国内可达性通常也更好；
//  ③ releases.atom 订阅源：同为 web 节点，XML 里第一条即最新 Release。
// 三端（macOS/Windows/Linux）通用；全部失败才判定为检查失败。
async function fetchLatestVersion() {
  const repo = REPO_OWNER + "/" + REPO_NAME;

  // ① REST API
  try {
    const res = await fetchWithTimeout("https://api.github.com/repos/" + repo + "/releases/latest");
    if (res.ok) {
      const data = await res.json();
      const tag = String((data && data.tag_name) || "").replace(/^v/i, "");
      if (tag) return tag;
    }
  } catch (e) { /* 尝试下一个渠道 */ }

  // ② /releases/latest 页面重定向
  try {
    const res = await fetchWithTimeout("https://github.com/" + repo + "/releases/latest");
    const m = String(res.url || "").match(/\/releases\/tag\/([^/?#]+)/);
    if (m && m[1]) return m[1].replace(/^v/i, "");
  } catch (e) { /* 尝试下一个渠道 */ }

  // ③ releases.atom
  try {
    const res = await fetchWithTimeout("https://github.com/" + repo + "/releases.atom");
    if (res.ok) {
      const xml = await res.text();
      const m = xml.match(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/);
      if (m && m[1]) return m[1].replace(/^v/i, "");
    }
  } catch (e) { /* 全部失败 */ }

  return null;
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map(function (n) {
    return parseInt(n, 10) || 0;
  });
  const pb = String(b).replace(/^v/i, "").split(".").map(function (n) {
    return parseInt(n, 10) || 0;
  });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title: title, body: body }).show();
  } catch (e) {
    /* 通知不可用时静默跳过 */
  }
}

function hasNewVersion() {
  return !!latestRelease && compareVersions(latestRelease.version, APP_VERSION) > 0;
}

async function checkUpdate(manual) {
  try {
    const version = await fetchLatestVersion();
    if (!version) throw new Error("all channels failed");
    latestRelease = {
      version: version,
      url: "https://github.com/" + REPO_OWNER + "/" + REPO_NAME + "/releases/tag/v" + version,
    };

    if (compareVersions(version, APP_VERSION) > 0) {
      refreshTrayMenu();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-available", latestRelease);
      }
      notify("简易笔记 · 发现新版本", "最新版 v" + version + " 已发布，点击托盘图标可下载");
      scheduleUpdateCheck(6 * 60 * 60 * 1000);
      return { ok: true, hasUpdate: true, latest: latestRelease };
    }

    refreshTrayMenu();
    if (manual) notify("简易笔记", "当前已是最新版本 v" + APP_VERSION);
    scheduleUpdateCheck(6 * 60 * 60 * 1000);
    return { ok: true, hasUpdate: false };
  } catch (e) {
    // 失败时把原因带回渲染端，界面明确提示（不再静默）；10 分钟后自动重试
    scheduleUpdateCheck(10 * 60 * 1000);
    if (manual) notify("简易笔记", "检查更新失败，请稍后重试");
    return { ok: false, hasUpdate: false, error: String((e && e.message) || e) };
  }
}

function showAbout() {
  const lines = [
    "版本：v" + APP_VERSION,
    "一个高度还原 Simplenote 的纯中文笔记软件",
    "github.com/" + REPO_OWNER + "/" + REPO_NAME,
  ];
  if (hasNewVersion()) {
    lines.push("", "发现新版本 v" + latestRelease.version + "，点击「检查更新」前往下载");
  }
  dialog
    .showMessageBox({
      type: "info",
      title: "关于简易笔记",
      message: "简易笔记 v" + APP_VERSION,
      detail: lines.join("\n"),
      buttons: ["确定", "检查更新"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .then(function (r) {
      if (r.response === 1) checkUpdate(true);
    });
}

ipcMain.handle("get-app-version", function () {
  return APP_VERSION;
});

ipcMain.handle("check-update", function () {
  return checkUpdate(true);
});

ipcMain.handle("open-external", function (_e, url) {
  if (typeof url !== "string" || !url) return;
  if (/^https?:\/\//.test(url)) {
    shell.openExternal(url);
    return;
  }
  // easynote-file:///… → 用系统默认程序打开本地文件（"引用路径"模式图片的点击打开）
  const m = url.match(/^easynote-file:\/\/(.*)$/i);
  if (m) {
    let p = decodeURIComponent(m[1]);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // Windows: /C:/x → C:/x
    shell.openPath(p);
  }
});

// 读取系统剪贴板文本（右键「粘贴」走这里，比 document.execCommand("paste") 可靠）
ipcMain.handle("get-clipboard-text", function () {
  try {
    return clipboard.readText();
  } catch (e) {
    return "";
  }
});

// 无法被 nativeImage 解码时，按扩展名猜测 MIME
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
};

// 本地图片文件 → data: URI（必要时等比缩小，最长边 ≤ 1600px）。
// pick-image（内嵌模式）与 embed-image-paths（外链图片迁移）共用。
// 返回 null 表示读取/解码失败（文件不存在或不是图片）。
function fileToDataUrl(p) {
  try {
    const buf = fs.readFileSync(p);
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) {
      // 个别格式（如 heic）nativeImage 解码失败，直接以原始字节内嵌
      const mime = MIME_BY_EXT[path.extname(p).toLowerCase()] || "image/png";
      return "data:" + mime + ";base64," + buf.toString("base64");
    }
    const s = img.getSize();
    const MAX = 1600;
    const longest = Math.max(s.width, s.height);
    if (longest > MAX) {
      const f = MAX / longest;
      img = img.resize({ width: Math.round(s.width * f), height: Math.round(s.height * f) });
    }
    return img.toDataURL();
  } catch (e) {
    return null;
  }
}

// 弹出系统文件选择框，挑选要插入的图片。
// mode = "path" 时只返回 { name, path }（不读文件、不转码，笔记里存引用）；
// mode = "embed"（默认）时额外返回 { dataUrl }（必要时等比缩小后内嵌 base64）。
ipcMain.handle("pick-image", function (_e, mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  return dialog
    .showOpenDialog(mainWindow, {
      title: "选择要插入的图片",
      properties: ["openFile"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"] },
      ],
    })
    .then(function (res) {
      if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
      const p = res.filePaths[0];
      const name = path.basename(p);
      // 引用路径模式：只给路径，渲染端拼 file:// 存入笔记
      if (mode === "path") return { name: name, path: p };
      const dataUrl = fileToDataUrl(p);
      if (!dataUrl) return null;
      return { name: name, path: p, dataUrl: dataUrl };
    })
    .catch(function () {
      return null;
    });
});

// 把一批本地图片路径批量转成 data: URI（「外链图片转内嵌」用）。
// 入参：绝对路径数组；返回：{ "<路径>": "data:...", ... }（读取失败的路径不在结果里）。
ipcMain.handle("embed-image-paths", function (_e, paths) {
  const out = {};
  if (!Array.isArray(paths)) return out;
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const dataUrl = fileToDataUrl(p);
    if (dataUrl) out[p] = dataUrl;
  }
  return out;
});

// 「引用文件路径」模式的图片显示：渲染端把 markdown 里的 file:// 改写为
// easynote-file:// 后由这里按本地路径读取返回（Chromium 禁止 file:// 页面
// 跨目录加载 file:// 图片，故借自定义协议绕过；只放行图片类型）。
const IMG_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};
function registerLocalFileProtocol() {
  protocol.handle("easynote-file", function (request) {
    try {
      const u = new URL(request.url);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // Windows: /C:/x → C:/x
      const mime = IMG_MIME_BY_EXT[path.extname(p).toLowerCase()];
      if (!mime) return new Response("forbidden", { status: 403 });
      const buf = fs.readFileSync(p);
      return new Response(buf, {
        headers: { "Content-Type": mime, "Cache-Control": "no-cache" },
      });
    } catch (e) {
      return new Response("not found", { status: 404 });
    }
  });
}

ipcMain.handle("set-titlebar-dark", function (_e, dark) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    applyTitlebarTheme(mainWindow, !!dark);
  }
});

ipcMain.handle("toggle-maximize", function () {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

/* ============ WebDAV 导出 ============ */
function webdavAuth(user, pass) {
  return "Basic " + Buffer.from(user + ":" + pass).toString("base64");
}
function normalizeDavUrl(u) {
  u = (u || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
}
// 探测 WebDAV 连通性：PROPFIND 目标目录
async function davTest(cfg) {
  const base = normalizeDavUrl(cfg.server);
  if (!base) return { ok: false, error: "请填写服务器地址" };
  const dir = (cfg.dir || "/easynote").replace(/^\/+|\/+$/g, "");
  const url = base + "/" + dir + "/";
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: webdavAuth(cfg.username || "", cfg.password || ""),
      Depth: "0",
    },
  });
  // 200/207 = 目录存在；401 = 账号密码错；404 = 目录不存在（可创建）
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "认证失败，请检查用户名和密码" };
  }
  if (res.status === 404) return { ok: true, needMkcol: true, url: url };
  if (res.ok || res.status === 207) return { ok: true, url: url };
  return { ok: false, error: "服务器返回 HTTP " + res.status };
}
async function davMkcol(url, cfg) {
  const res = await fetch(url, {
    method: "MKCOL",
    headers: { Authorization: webdavAuth(cfg.username || "", cfg.password || "") },
  });
  // 405 = 目录已存在，视为成功
  if (res.ok || res.status === 405) return;
  throw new Error("创建目录失败（HTTP " + res.status + "）");
}
async function davPut(url, cfg, content, type) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: webdavAuth(cfg.username || "", cfg.password || ""),
      "Content-Type": type || "text/plain; charset=utf-8",
    },
    body: content,
  });
  if (!res.ok && res.status !== 204 && res.status !== 201) {
    throw new Error("上传失败（HTTP " + res.status + "）");
  }
}
function safeFileName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>| -]/g, "_")
    .slice(0, 60) || "note";
}
ipcMain.handle("webdav-test", function (_e, cfg) {
  return davTest(cfg).catch(function (e) {
    return { ok: false, error: String((e && e.message) || e) };
  });
});
ipcMain.handle("webdav-export", function (_e, cfg, notes) {
  return (async function () {
    const base = normalizeDavUrl(cfg.server);
    if (!base) return { ok: false, error: "请先填写 WebDAV 服务器地址" };
    if (!Array.isArray(notes)) return { ok: false, error: "没有可导出的笔记" };
    const dir = (cfg.dir || "/easynote").replace(/^\/+|\/+$/g, "");
    const prefix = base + "/" + dir + "/";
    const auth = { username: cfg.username || "", password: cfg.password || "" };

    // 1. 确保目录存在
    const t = await davTest(cfg);
    if (!t.ok) return t;
    if (t.needMkcol) await davMkcol(prefix, auth);

    // 2. 全量 JSON 备份
    const stamp = new Date().toISOString().slice(0, 10);
    await davPut(prefix + "easynote-backup-" + stamp + ".json", auth,
      JSON.stringify({ version: APP_VERSION, exportedAt: new Date().toISOString(), notes: notes }, null, 2),
      "application/json; charset=utf-8");

    // 3. 每条笔记一个 Markdown 文件
    let okCount = 0;
    const failed = [];
    for (const n of notes) {
      const title = ((n.content || "").split("\n").find(function (l) { return l.trim(); }) || "无标题").trim();
      const md =
        "# " + title + "\n\n" +
        "- 创建时间：" + new Date(n.createdDate || Date.now()).toLocaleString("zh-CN") + "\n" +
        "- 修改时间：" + new Date(n.modifiedDate || Date.now()).toLocaleString("zh-CN") + "\n" +
        (n.deleted ? "- 状态：回收站\n" : "") + "\n---\n\n" + (n.content || "");
      try {
        await davPut(prefix + safeFileName(title) + "-" + n.id + ".md", auth, md, "text/markdown; charset=utf-8");
        okCount++;
      } catch (e) {
        failed.push(title + "：" + e.message);
      }
    }
    return { ok: failed.length === 0, count: okCount, total: notes.length, failed: failed, url: prefix };
  })().catch(function (e) {
    return { ok: false, error: String((e && e.message) || e) };
  });
});

// 中文菜单（Windows / macOS / Linux 通用）
function buildMenu(win) {
  const isMac = process.platform === "darwin";
  const template = [];

  if (isMac) {
    template.push({
      label: "简易笔记",
      submenu: [
        { role: "about", label: "关于简易笔记" },
        { type: "separator" },
        { role: "hide", label: "隐藏简易笔记" },
        { role: "hideOthers", label: "隐藏其他应用" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出简易笔记" },
      ],
    });
  }

  template.push({
    label: "文件",
    submenu: [
      {
        label: "新建笔记",
        accelerator: "CmdOrCtrl+N",
        click: function () {
          if (win) win.webContents.send("menu-new-note");
        },
      },
      { type: "separator" },
      isMac
        ? { role: "close", label: "关闭窗口" }
        : { role: "quit", label: "退出" },
    ],
  });

  template.push({
    label: "编辑",
    submenu: [
      { role: "undo", label: "撤销" },
      { role: "redo", label: "重做" },
      { type: "separator" },
      { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" },
      { role: "selectAll", label: "全选" },
    ],
  });

  template.push({
    label: "视图",
    submenu: [
      { role: "reload", label: "重新加载" },
      { role: "toggleDevTools", label: "开发者工具" },
      { type: "separator" },
      { role: "resetZoom", label: "实际大小" },
      { role: "zoomIn", label: "放大" },
      { role: "zoomOut", label: "缩小" },
      { type: "separator" },
      { role: "togglefullscreen", label: "全屏" },
    ],
  });

  template.push({
    label: "窗口",
    submenu: [
      { role: "minimize", label: "最小化" },
      { role: "zoom", label: "缩放" },
      ...(isMac
        ? [{ role: "front", label: "全部置于顶层" }]
        : [{ role: "close", label: "关闭" }]),
    ],
  });

  template.push({
    label: "帮助",
    submenu: [{ role: "about", label: "关于简易笔记" }],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 单实例：保证整个系统只运行一个窗口；第二个实例启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });

  app.whenReady().then(() => {
    registerLocalFileProtocol();
    mainWindow = createWindow();
    buildMenu(mainWindow);
    createTray();
    // 启动 5 秒后静默检查一次更新；之后由 scheduleUpdateCheck 自动续期
    // （成功 → 6 小时；失败 → 10 分钟重试）
    scheduleUpdateCheck(5000);
    // 系统深浅色变化时推送给渲染进程（跟随系统模式）
    nativeTheme.on("updated", () => {
      [mainWindow, ...BrowserWindow.getAllWindows()].forEach(function (w) {
        if (w && !w.isDestroyed()) {
          w.webContents.send("system-theme-changed", nativeTheme.shouldUseDarkColors);
        }
      });
    });
    app.on("activate", () => {
      showWindow();
    });
  });
}

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("window-all-closed", () => {
  // 有托盘时保持后台运行，退出走托盘菜单
});
