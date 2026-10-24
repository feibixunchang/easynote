/* ============ Electron 预加载脚本 ============ */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getSystemFonts: function () {
    return ipcRenderer.invoke("get-system-fonts");
  },
  onMenuNewNote: function (cb) {
    ipcRenderer.on("menu-new-note", function () {
      cb();
    });
  },
  getAppVersion: function () {
    return ipcRenderer.invoke("get-app-version");
  },
  checkUpdate: function () {
    return ipcRenderer.invoke("check-update");
  },
  openExternal: function (url) {
    return ipcRenderer.invoke("open-external", url);
  },
  getClipboardText: function () {
    return ipcRenderer.invoke("get-clipboard-text");
  },
  writeClipboard: function (text) {
    return ipcRenderer.invoke("write-clipboard", text);
  },
  getPlatform: function () {
    return ipcRenderer.invoke("get-platform");
  },
  setCloseBehavior: function (toTray) {
    return ipcRenderer.invoke("set-close-behavior", toTray);
  },
  minimizeWindow: function () {
    return ipcRenderer.invoke("minimize-window");
  },
  closeWindow: function () {
    return ipcRenderer.invoke("close-window");
  },
  saveFile: function (opts) {
    return ipcRenderer.invoke("save-file", opts);
  },
  pickImage: function (mode) {
    return ipcRenderer.invoke("pick-image", mode);
  },
  embedImagePaths: function (paths) {
    return ipcRenderer.invoke("embed-image-paths", paths);
  },
  onUpdateAvailable: function (cb) {
    ipcRenderer.on("update-available", function (_e, info) {
      cb(info);
    });
  },
  startUpdate: function (version) {
    return ipcRenderer.invoke("start-update", version);
  },
  onUpdateStatus: function (cb) {
    ipcRenderer.on("update-status", function (_e, s) {
      cb(s);
    });
  },
  setTitlebarDark: function (dark) {
    return ipcRenderer.invoke("set-titlebar-dark", dark);
  },
  toggleMaximize: function () {
    return ipcRenderer.invoke("toggle-maximize");
  },
  onSystemThemeChanged: function (cb) {
    ipcRenderer.on("system-theme-changed", function (_e, dark) {
      cb(dark);
    });
  },
  webdavTest: function (cfg) {
    return ipcRenderer.invoke("webdav-test", cfg);
  },
  webdavExport: function (cfg, notes) {
    return ipcRenderer.invoke("webdav-export", cfg, notes);
  },
});
