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
  onUpdateAvailable: function (cb) {
    ipcRenderer.on("update-available", function (_e, info) {
      cb(info);
    });
  },
});
