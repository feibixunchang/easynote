/* ============ Electron 主进程 ============ */
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, Notification } = require("electron");
const path = require("path");
const { execSync } = require("child_process");

const APP_VERSION = app.getVersion();
const REPO_OWNER = "feibixunchang";
const REPO_NAME = "easynote";

// 枚举 Windows 已安装字体（读取系统字体注册表）
function getSystemFonts() {
  try {
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
  } catch (e) {
    return [];
  }
}

ipcMain.handle("get-system-fonts", function () {
  return getSystemFonts();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: "#ffffff",
    title: "简易笔记",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

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
  // 256 尺寸由 Electron 自动缩放到各平台托盘大小
  const candidates = [
    path.join(__dirname, "build/icons/256x256.png"),
    path.join(__dirname, "build/icons/128x128.png"),
    path.join(__dirname, "build/icon.png"),
  ];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createFromPath(path.join(__dirname, "build/icons/48x48.png"));
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
    const res = await fetch(
      "https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + "/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "easynote-update-check",
        },
      }
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const version = String(data.tag_name || "").replace(/^v/i, "");
    latestRelease = { version: version, url: data.html_url || "" };

    if (compareVersions(version, APP_VERSION) > 0) {
      refreshTrayMenu();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-available", latestRelease);
      }
      notify("简易笔记 · 发现新版本", "最新版 v" + version + " 已发布，点击托盘图标可下载");
      return { ok: true, hasUpdate: true, latest: latestRelease };
    }

    refreshTrayMenu();
    if (manual) notify("简易笔记", "当前已是最新版本 v" + APP_VERSION);
    return { ok: true, hasUpdate: false };
  } catch (e) {
    if (manual) notify("简易笔记", "检查更新失败，请稍后重试");
    return { ok: false, error: String((e && e.message) || e) };
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
  if (typeof url === "string" && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
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

app.whenReady().then(() => {
  mainWindow = createWindow();
  buildMenu(mainWindow);
  createTray();
  // 启动 5 秒后静默检查一次更新，之后每 6 小时一次
  setTimeout(() => checkUpdate(false), 5000);
  setInterval(() => checkUpdate(false), 6 * 60 * 60 * 1000);
  app.on("activate", () => {
    showWindow();
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("window-all-closed", () => {
  // 有托盘时保持后台运行，退出走托盘菜单
});
