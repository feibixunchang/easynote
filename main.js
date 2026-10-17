/* ============ Electron 主进程（Windows 外壳） ============ */
const { app, BrowserWindow, ipcMain } = require("electron");
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
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
