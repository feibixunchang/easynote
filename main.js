/* ============ Electron 主进程 ============ */
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, Notification, nativeTheme, clipboard, protocol, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const updater = require("./updater");

const APP_VERSION = app.getVersion();
const REPO_OWNER = "feibixunchang";
const REPO_NAME = "easynote";

// Windows：必须显式设置 AppUserModelID，否则系统通知（新版本提醒、托盘提示）会被系统直接丢弃，
// 任务栏也可能把窗口归到 electron.exe 名下（图标/固定行为异常）。macOS/Linux 无此概念。
if (process.platform === "win32") {
  try {
    app.setAppUserModelId("com.workbuddy.simplenotezh");
  } catch (e) {}
}

// 主题色：与界面 CSS 变量保持一致（浅色 #f7f7f7 侧栏 / 深色 #252525）
// 标题栏用编辑器背景色，视觉上与主界面连成一体
const THEME_COLORS = {
  light: { bg: "#ffffff", fg: "#333333" },
  dark: { bg: "#1e1e1e", fg: "#e2e2e2" },
};

// 标题栏高度：与 styles.css 里 .titlebar-strip 的 34px 严格一致，
// 否则 Windows 原生按钮覆盖层会和 HTML 标题栏错位。
const TITLEBAR_HEIGHT = 34;

// Windows 专用：系统原生「最小化 / 最大化 / 关闭」按钮覆盖层。
// 历史教训（1.2.15 仍然踩坑）：Windows 上只要 HTML 标题栏整条是 drag 拖拽区，
// 即使子元素写了 no-drag，点击也经常被系统当作"拖动窗口"吞掉 —— 用户点了 ✕ 毫无反应。
// 原生覆盖层按钮由操作系统绘制、在 Web 内容之上，点击由窗口过程直接处理，绝不可能被吞。
const USE_NATIVE_OVERLAY = process.platform === "win32";

/* ============ 系统字体枚举（异步 + 双层缓存，绝不阻塞主进程） ============ */
// 历史坑：以前用 execSync 跑 `system_profiler SPFontsDataType -json`，
// 在 M 系列 Mac 上实测要 40 秒（15s 超时后抛异常，静默回退到兜底列表），
// 结果就是点一下「设置」主进程整整冻住 15 秒，用户看到的指针一直在转。
// 现在的做法：
//   1) macOS 改用 osascript + JXA 调 NSFontManager，0.4 秒拿到 400+ 字体族；
//   2) 全部 execFile 异步，主进程永不阻塞；
//   3) 内存 + userData/system-fonts.json 双层缓存，第二次起瞬开；
//   4) 启动后空闲预热，用户点设置时基本已命中缓存；
//   5) 并发请求合并成一次子进程调用。
let fontCache = null;
let fontPending = null;

// JXA：NSFontManager.availableFontFamilies → JSON 数组
const JXA_LIST_FONTS =
  'ObjC.import("AppKit");' +
  'var a = $.NSFontManager.sharedFontManager.availableFontFamilies;' +
  'var out = [];' +
  'for (var i = 0; i < a.count; i++) { out.push(ObjC.unwrap(a.objectAtIndex(i))); }' +
  'JSON.stringify(out);';

function runCommand(file, args, opts) {
  return new Promise(function (resolve, reject) {
    execFile(
      file,
      args,
      Object.assign(
        {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          timeout: 15000,
        },
        opts || {}
      ),
      function (err, stdout) {
        if (err) reject(err);
        else resolve(String(stdout || ""));
      }
    );
  });
}

function uniqSorted(names) {
  const set = new Set();
  (names || []).forEach(function (n) {
    const s = String(n == null ? "" : n).trim();
    // 以「.」开头的是 macOS 内部私有字体（.PingFang SC / .Hiragino ... Interface），
    // 用户在字体下拉里根本用不上，直接过滤，免得列表里一堆看不懂的名字。
    if (s && s.charAt(0) !== ".") set.add(s);
  });
  return [...set].sort(function (a, b) {
    try {
      return a.localeCompare(b, "zh-Hans-CN");
    } catch (e) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
  });
}

function parseFcList(out) {
  const names = [];
  String(out || "").split("\n").forEach(function (line) {
    // fc-list 一行可能含多个字体族（逗号分隔）
    line.split(",").forEach(function (f) {
      names.push(f);
    });
  });
  return uniqSorted(names);
}

async function getMacFonts() {
  // 首选：JXA + NSFontManager（实测 0.4s / 426 个字体族）
  try {
    const out = await runCommand(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", JXA_LIST_FONTS],
      { timeout: 12000 }
    );
    const list = JSON.parse(out);
    if (Array.isArray(list) && list.length) return uniqSorted(list);
  } catch (e) {}
  // 兜底 1：装了 fontconfig 的机器（brew install fontconfig）
  try {
    const out = await runCommand("fc-list", [":", "family"], { timeout: 12000 });
    const list = parseFcList(out);
    if (list.length) return list;
  } catch (e) {}
  // 兜底 2：扫描字体目录里的文件名（不解析字体表，仅取文件名，聊胜于无）
  try {
    const dirs = [
      "/System/Library/Fonts",
      "/System/Library/Fonts/Supplemental",
      "/Library/Fonts",
      path.join(app.getPath("home"), "Library/Fonts"),
    ];
    const names = [];
    dirs.forEach(function (dir) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (e) {
        return;
      }
      entries.forEach(function (f) {
        const m = f.match(/^(.+?)\.(ttf|otf|ttc|dfont)$/i);
        if (m) names.push(m[1].replace(/[-_]+/g, " "));
      });
    });
    return uniqSorted(names);
  } catch (e) {
    return [];
  }
}

async function getWindowsFonts() {
  const out = await runCommand("reg", [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    "/s",
  ]);
  const names = [];
  out.split("\n").forEach(function (line) {
    const m = line.match(/(.+?)\s+REG_SZ\s+\S/);
    if (m) {
      names.push(
        m[1].replace(/\s*\((TrueType|OpenType|OpenType CFF|Type 1)\)\s*$/i, "")
      );
    }
  });
  return uniqSorted(names);
}

async function getLinuxFonts() {
  // Linux：fontconfig 列出字体族名（fc-list 属于 fontconfig 包，桌面环境必装）
  const out = await runCommand("fc-list", [":", "family"]);
  return parseFcList(out);
}

function fontsCacheFile() {
  try {
    return path.join(app.getPath("userData"), "system-fonts.json");
  } catch (e) {
    return null;
  }
}

function readFontsCache() {
  const file = fontsCacheFile();
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && Array.isArray(raw.fonts) && raw.fonts.length) return raw.fonts;
  } catch (e) {}
  return null;
}

function writeFontsCache(list) {
  const file = fontsCacheFile();
  if (!file || !list || !list.length) return;
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ fonts: list, savedAt: Date.now() }),
      "utf8"
    );
  } catch (e) {}
}

function collectFonts() {
  if (fontPending) return fontPending;
  const job =
    process.platform === "win32"
      ? getWindowsFonts()
      : process.platform === "darwin"
      ? getMacFonts()
      : getLinuxFonts();
  fontPending = job.then(
    function (list) {
      fontPending = null;
      if (list && list.length) {
        fontCache = list;
        writeFontsCache(list);
        return list;
      }
      return fontCache || readFontsCache() || [];
    },
    function () {
      // 枚举失败（超时 / 权限 / 系统限制）退回缓存，永不抛给渲染进程
      fontPending = null;
      return fontCache || readFontsCache() || [];
    }
  );
  return fontPending;
}

// force=true 强制重新枚举（给「刷新字体列表」用），否则优先走缓存
function getSystemFonts(force) {
  if (!force && fontCache) return Promise.resolve(fontCache);
  if (fontPending) return fontPending;
  if (!force) {
    const cached = readFontsCache();
    if (cached) {
      fontCache = cached;
      // 落盘缓存命中：立刻返回，同时在后台静默刷新一次，
      // 这样用户新装的字体下次打开设置就能看到，且完全不与 UI 抢时间。
      const t = setTimeout(function () {
        collectFonts();
      }, 2500);
      if (t && typeof t.unref === "function") t.unref();
      return Promise.resolve(cached);
    }
  }
  return collectFonts();
}

ipcMain.handle("get-system-fonts", function (_event, force) {
  return getSystemFonts(force === true);
});

/* ============ 标题栏与主界面一体色 ============ */
// Windows / Linux：隐藏系统标题栏 + 原生窗口按钮覆盖层（颜色随主题）
// macOS：隐藏标题栏保留交通灯，背景色随主题
function applyTitlebarTheme(win, dark) {
  const c = dark ? THEME_COLORS.dark : THEME_COLORS.light;
  // Windows：原生按钮覆盖层的配色跟着主题走（浅色白底深灰符号 / 深色黑底浅灰符号）
  if (USE_NATIVE_OVERLAY && win && typeof win.setTitleBarOverlay === "function") {
    try {
      win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT });
    } catch (e) {}
  }
  win.setBackgroundColor(c.bg);
}

// 记住并恢复窗口尺寸 / 位置：用户拉好的大小下次启动依然生效
function winStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(winStateFile(), "utf8"));
    if (s && typeof s.width === "number" && typeof s.height === "number") return s;
  } catch (e) {}
  return null;
}
// 保存：最大化时存"还原后的尺寸"（getNormalBounds），否则下次启动会得到一个巨大的普通窗口。
// 同时记录 maximized 标记，启动时按原样最大化。
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(winStateFile(), JSON.stringify({ ...bounds, maximized }));
  } catch (e) {}
}
// 判断保存的位置是否还在某个显示器可见范围内：
// 拔掉外接显示器 / 改过分辨率后，旧坐标可能落在屏幕外，窗口一启动就"消失"。
function isBoundsVisible(bounds) {
  try {
    return screen.getAllDisplays().some(function (d) {
      const a = d.workArea;
      const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
      const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
      // 至少露出 120×60 才算"看得见"（够用户抓住标题栏拖回来）
      return overlapX >= 120 && overlapY >= 60;
    });
  } catch (e) {
    return true; // 拿不到屏幕信息时不要因噎废食
  }
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const c = dark ? THEME_COLORS.dark : THEME_COLORS.light;
  const isMac = process.platform === "darwin";
  const winOpts = {
    width: 1100,
    height: 780,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: c.bg,
    title: "简易笔记",
    // 隐藏系统标题栏，让标题区域与主界面同色：
    // windows → 原生按钮覆盖层（OS 级按钮，点击最可靠）；macOS → 左上角交通灯；Linux → HTML 按钮
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 关掉后台定时器 throttling：缩到托盘 / 窗口被遮挡时，定时同步照常运行，
      // 保证多端"近实时同步"的体验不中断
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  };
  if (USE_NATIVE_OVERLAY) {
    winOpts.titleBarOverlay = { color: c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT };
  }
  const win = new BrowserWindow(winOpts);

  // 恢复上次保存的窗口尺寸 / 位置（用户自己调好的大小下次启动依然生效）
  const saved = loadWindowState();
  if (saved) {
    const bounds = {
      width: Math.max(saved.width, 820),
      height: Math.max(saved.height, 520),
    };
    const hasXY = typeof saved.x === "number" && typeof saved.y === "number";
    if (hasXY) {
      bounds.x = saved.x;
      bounds.y = saved.y;
    }
    // 位置已经不在任何显示器可见范围内（拔了外接屏 / 改了分辨率）→ 丢弃坐标，让系统居中
    if (!hasXY || isBoundsVisible(bounds)) {
      try { win.setBounds(bounds, false); } catch (e) {}
    } else {
      try { win.setBounds({ width: bounds.width, height: bounds.height }, false); win.center(); } catch (e) {}
    }
    if (saved.maximized) {
      try { win.maximize(); } catch (e) {}
    }
  }

  win.loadFile(path.join(__dirname, "index.html"));
  applyTitlebarTheme(win, dark);

  // 关闭窗口：按用户设置决定「隐藏到托盘」还是「直接退出」。
  // 老版本一律隐藏到托盘，Windows 用户点 ✕ 后窗口消失、程序还在后台，
  // 很容易被理解成"点了没反应 / 关不掉"，所以这里做成可配置，并在第一次隐藏时给一次提示。
  win.on("close", function (e) {
    saveWindowState(win);
    if (app.isQuitting) return; // 托盘「退出」/ 更新安装：真的退出
    if (!closeToTray) {
      // 用户选了「关闭即退出」：这里必须真的把进程退掉。
      // 只置标记不 quit 的话，窗口关了但进程还在（window-all-closed 是有意留空的），
      // 结果又变成"窗口没了、程序还在后台"——正是这次要修掉的问题。
      app.isQuitting = true;
      app.quit();
      return;
    }
    e.preventDefault();
    win.hide();
    showTrayHintOnce();
    return false;
  });

  // 拖拽 / 缩放窗口后，防抖保存尺寸与位置
  let saveTimer = null;
  const scheduleSave = function () {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveWindowState(win); }, 500);
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);

  return win;
}

/* ============ 托盘图标 ============ */
let tray = null;
let mainWindow = null;
// 关闭主窗口的行为：true = 隐藏到托盘继续后台同步（默认），false = 直接退出程序。
// 由渲染进程在启动时按用户设置同步过来（设置项存在 localStorage，单一数据源）。
// Linux 默认「关闭即退出」：很多发行版（GNOME/Wayland）托盘区默认不显示图标，
// 隐藏到托盘 = 程序还在跑但用户再也找不到窗口。Windows/macOS 托盘稳定，默认隐藏到托盘。
let closeToTray = process.platform !== "linux";
let trayHintShown = false;

// 第一次隐藏到托盘时给一次系统通知，避免用户以为"关不掉 / 程序卡死"
function showTrayHintOnce() {
  if (trayHintShown) return;
  trayHintShown = true;
  notify(
    "简易笔记仍在后台运行",
    "窗口已最小化到系统托盘，点托盘图标可重新打开；右键托盘图标可退出。可在「设置 → 关闭主窗口时」改为直接退出。"
  );
}

function getTrayIcon() {
  // 图标选型分两套，不能混用：
  //   macOS → 白色笔记本造型 + 模板图机制（菜单栏自动单色，深浅菜单栏都好看）
  //   Windows/Linux → 彩色应用图标（Windows 通知区域默认深色，白色模板图会"隐身"，
  //                   用户找不到托盘图标就等于无法恢复窗口）
  if (process.platform === "darwin") {
    const trayPath = path.join(__dirname, "build/icons/tray-mac.png");
    try {
      const buf = fs.readFileSync(trayPath);
      let img = nativeImage.createFromBuffer(buf);
      if (img && !img.isEmpty()) {
        img.setTemplateImage(true);
        const s = img.getSize();
        if (s.height > 20) img = img.resize({ height: 18, quality: "best" });
        return img;
      }
    } catch (e) {
      /* 走通用图标 */
    }
  }
  // 彩色图标（Windows/Linux 与 macOS 的兜底）
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
        if (process.platform === "darwin") img.setTemplateImage(true);
        const s = img.getSize();
        // Windows 通知区域的图标按 16px 左右显示，给个 24px 保证清晰不糊
        const target = process.platform === "darwin" ? 18 : 24;
        if (s.height > target) img = img.resize({ height: target, quality: "best" });
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
          label: "⬆ 下载并安装 v" + latestRelease.version,
          click: function () {
            // 与界面里的「下载」按钮同一条应用内更新链路：测速 → 下载（带进度）→ 自动关旧客户端安装。
            // 老版本这里直接 shell.openExternal 跳 GitHub 网页，与 1.2.13 起的应用内更新自相矛盾。
            showWindow();
            updater.downloadAndInstall({
              version: latestRelease.version,
              onStatus: function (s) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send("update-status", s);
                }
              },
            });
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

// 桌面端只认纯 semver 发布 tag：v1.2.3 / 1.2.3 / 1.2（可有前导 v）。
// 移动端发布使用 mobile-v* 标签，必须在更新检查里过滤掉，否则桌面端会把
// 移动端版本误判为自己的新版本，并构造出错误的下载地址。
const DESKTOP_TAG_RE = /^v?\d+(?:\.\d+){1,2}$/;
function normalizeDesktopTag(tag) {
  const t = String(tag || "").trim();
  if (!DESKTOP_TAG_RE.test(t)) return null;
  return t.replace(/^v/i, "");
}

// 多渠道探测最新桌面端版本号（任一成功即返回 "x.y.z" 字符串）：
//  ① api.github.com REST 接口：请求 releases 列表并挑第一条纯 semver tag。
//     注意不能用 /releases/latest——它返回的是"最新一个 Release"，
//     可能是移动端的 mobile-v* 发布；列表 + 过滤才能稳定拿到桌面端最新版。
//     未认证限额 60 次/小时/IP，共用出口 IP（公司网络/代理）容易 403；
//  ② github.com 的 /releases/latest 页面：302 重定向到最新 tag 的页面，
//     走 web 节点、限额宽得多，国内可达性通常也更好；只有重定向目标
//     是纯 semver tag 时才采用（否则说明最新发布是移动端，交给 atom 扫列表）；
//  ③ releases.atom 订阅源：同为 web 节点，XML 按发布时间倒序，
//     扫出第一条纯 semver 的桌面端 tag。
// 三端（macOS/Windows/Linux）通用；全部失败才判定为检查失败。
async function fetchLatestVersion() {
  const repo = REPO_OWNER + "/" + REPO_NAME;

  // ① REST API releases 列表 + semver 过滤
  try {
    const res = await fetchWithTimeout("https://api.github.com/repos/" + repo + "/releases?per_page=20");
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        for (const item of list) {
          const v = normalizeDesktopTag(item && item.tag_name);
          if (v) return v;
        }
      }
    }
  } catch (e) { /* 尝试下一个渠道 */ }

  // ② /releases/latest 页面重定向
  try {
    const res = await fetchWithTimeout("https://github.com/" + repo + "/releases/latest");
    const m = String(res.url || "").match(/\/releases\/tag\/([^/?#]+)/);
    const v = m && m[1] ? normalizeDesktopTag(m[1]) : null;
    if (v) return v;
  } catch (e) { /* 尝试下一个渠道 */ }

  // ③ releases.atom：倒序扫描，取第一条纯 semver 桌面端 tag
  try {
    const res = await fetchWithTimeout("https://github.com/" + repo + "/releases.atom");
    if (res.ok) {
      const xml = await res.text();
      const re = /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const v = normalizeDesktopTag(m[1]);
        if (v) return v;
      }
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

// 应用内自动更新：主进程跑「测速 → 下载（带进度）→ 安装并自动关闭旧客户端」全流程，
// 进度/状态通过 update-status 事件实时推给渲染端界面。version 不传则取刚检查到的最新版。
ipcMain.handle("start-update", function (_e, version) {
  const v = version || (latestRelease && latestRelease.version);
  if (!v) return { ok: false, error: "未知版本号" };
  updater.downloadAndInstall({
    version: v,
    onStatus: function (s) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-status", s);
      }
    },
  });
  return { ok: true };
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

// 写入系统剪贴板（右键「复制/剪切」、工具栏复制按钮走这里）。
// 主进程 clipboard 三端 100% 可靠，替代渲染进程里已废弃的 document.execCommand("copy")
// 与受安全上下文/聚焦限制的 navigator.clipboard.writeText。
ipcMain.handle("write-clipboard", function (_e, text) {
  if (typeof text !== "string") return false;
  try {
    clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
});

// 保存文本到本地文件（导出 Markdown 笔记）：弹系统保存对话框，用户选路径后写盘。
// 返回 { ok, path, canceled }：取消不算失败，渲染端据此不弹错误提示。
ipcMain.handle("save-file", async function (_e, opts) {
  opts = opts || {};
  var content = typeof opts.content === "string" ? opts.content : "";
  // 文件名里不能有路径分隔符 / 系统保留字符，统一替换掉
  var defaultName = String(opts.defaultName || "note.md").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  var filters = Array.isArray(opts.filters) ? opts.filters : [{ name: "Markdown", extensions: ["md"] }];
  var win = BrowserWindow.getFocusedWindow() || mainWindow;
  var dialogOpts = {
    title: "保存文件",
    defaultPath: path.join(app.getPath("documents"), defaultName),
    filters: filters,
  };
  try {
    var res = win
      ? await dialog.showSaveDialog(win, dialogOpts)
      : await dialog.showSaveDialog(dialogOpts);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fs.promises.writeFile(res.filePath, content, "utf8");
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, canceled: false, error: String((err && err.message) || err) };
  }
});

// 窗口控制：供 HTML 标题栏里的自定义按钮调用（Win/Linux 显示，macOS 用原生交通灯）
// 返回一个对象而不是裸字符串，方便渲染进程一次拿到"谁是系统按钮、谁是 HTML 按钮"：
//   overlay=true  → 系统已经画好了最小化/最大化/关闭（Windows），HTML 那三个按钮必须隐藏
//   overlay=false → 由界面自己画按钮（Linux）
ipcMain.handle("get-platform", function () {
  return {
    platform: process.platform,
    overlay: USE_NATIVE_OVERLAY,
    titlebarHeight: TITLEBAR_HEIGHT,
    closeDefault: process.platform === "linux" ? "quit" : "tray",
  };
});
ipcMain.handle("minimize-window", function () {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.handle("close-window", function () {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!closeToTray) {
    // 用户选择"关闭即退出"：走真正的退出流程
    app.isQuitting = true;
    app.quit();
    return;
  }
  // 走标准 close 流程：触发 win.on("close")，隐藏到托盘（与点 ✕ 行为一致）
  mainWindow.close();
});
// 用户在设置里切换「关闭主窗口时」的行为
ipcMain.handle("set-close-behavior", function (_e, toTray) {
  closeToTray = toTray !== false;
  return closeToTray;
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
    // 启动 4 秒后空闲预热字体缓存：用户点「设置」时直接命中，不再等枚举
    const fontWarm = setTimeout(() => {
      getSystemFonts().catch(() => {});
    }, 4000);
    if (fontWarm && typeof fontWarm.unref === "function") fontWarm.unref();
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
