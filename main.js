/* ============ Electron 主进程 ============ */
const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const { execSync } = require("child_process");

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
  return win;
}

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
  const win = createWindow();
  buildMenu(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      buildMenu(w);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
