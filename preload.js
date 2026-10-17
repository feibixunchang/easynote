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
});
