// electron-builder afterPack 钩子（仅 Linux）：
// 修复 deb 安装失败问题 —— Deepin 25 等系统上 /opt 与 /usr/share/icons
// 可能是不同文件系统，而 deb 里 /opt/.../build/icons/*.png 与
// /usr/share/icons/hicolor/*/apps/easynote.png 若共享同一 inode，
// 打包器会把后者写成前者的硬链接条目，dpkg 解包时跨设备建硬链接
// 报「Invalid cross-device link」导致安装中止。
// 这里在打包成 deb/AppImage 之前，把暂存区里 nlink>1 的普通文件
// 逐个复制成独立 inode，从根上避免 tar 产生硬链接条目。
const fs = require("fs");
const path = require("path");

function walk(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, onFile);
    else if (ent.isFile()) onFile(full);
  }
}

// 把硬链接文件替换为独立 inode 的普通文件（内容与权限保持不变）
function breakHardLink(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    return 0;
  }
  if (!st.isFile() || st.nlink <= 1) return 0;
  const tmp = file + ".__unlink_tmp__";
  try {
    const buf = fs.readFileSync(file);
    fs.writeFileSync(tmp, buf);
    fs.chmodSync(tmp, st.mode);
    fs.renameSync(tmp, file); // 同目录 rename：新 inode 替换旧的硬链接
    return 1;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return 0;
  }
}

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName;
  if (platform !== "linux" || !appOutDir || !fs.existsSync(appOutDir)) return;

  let broken = 0;
  walk(appOutDir, function (file) {
    broken += breakHardLink(file);
  });
  console.log(`[afterPack] 已解除 ${broken} 个硬链接（避免 deb 跨文件系统安装失败）`);
};
