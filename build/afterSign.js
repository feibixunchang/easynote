// electron-builder afterSign 钩子：在没有苹果开发者证书时，
// 对 macOS 应用做 ad-hoc 签名（identity = "-"），避免产物被 Gatekeeper / XProtect 拦截。
// 自底向上签名各组件，最后对主包 --deep 签名，规避 Electron 框架逐个签名顺序问题。
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function run(cmd) {
  console.log("[afterSign] " + cmd);
  execSync(cmd, { stdio: "inherit" });
}

function signAdhoc(p) {
  if (fs.existsSync(p)) run(`codesign --force --sign - "${p}"`);
}

exports.default = async function afterSign(context) {
  const appOutDir = context.appOutDir;
  const entries = fs.readdirSync(appOutDir).filter((f) => f.endsWith(".app"));
  if (entries.length === 0) {
    console.log("[afterSign] 未找到 .app，跳过");
    return;
  }
  const appPath = path.join(appOutDir, entries[0]);
  const fw = path.join(appPath, "Contents", "Frameworks");

  // 1) crashpad handler
  signAdhoc(path.join(fw, "Electron Framework.framework", "Versions", "Current", "Helpers", "chrome_crashpad_handler"));
  // 2) 各 framework
  ["Mantle.framework/Versions/Current", "ReactiveObjC.framework/Versions/Current", "Squirrel.framework/Versions/Current", "Electron Framework.framework/Versions/Current"].forEach((f) =>
    signAdhoc(path.join(fw, f))
  );
  // 3) 各 helper
  ["简易笔记 Helper.app", "简易笔记 Helper (GPU).app", "简易笔记 Helper (Plugin).app", "简易笔记 Helper (Renderer).app"].forEach((h) =>
    signAdhoc(path.join(fw, h))
  );
  // 4) 主包
  run(`codesign --force --deep --sign - "${appPath}"`);
  console.log("[afterSign] ad-hoc 签名完成");
};
