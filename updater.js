/* ============ 应用内自动更新引擎（updater.js） ============
 * 纯 Node 内置模块实现，不依赖任何第三方包（与本工程「运行时零 npm 依赖」约定一致）。
 *
 * 完整流程：
 *   1. 根据当前系统（win/mac/linux）从 GitHub Release 选取对应的安装包；
 *   2. 对多条下载渠道（GitHub 官方 + 国内常用镜像）做小样本测速，选最快的一条；
 *   3. 在应用内下载安装包，实时回报进度百分比 / 速度 / 当前渠道，任一渠道失败自动切换；
 *   4. 下载完成后自动关闭旧客户端并安装（Win 跑安装向导 / Mac 挂载 dmg 拷到「应用程序」/
 *      Linux 替换 AppImage 或调包管理器）。
 *
 * 安全说明：镜像仅用于加速「公开」安装包的下载，官方渠道永远作为保底。如果担心镜像
 * 投毒，把 DOWNLOAD_CHANNELS 里除「GitHub 官方」以外的项删掉即可——只会走官方。
 */
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { app } = require("electron");

const REPO_OWNER = "feibixunchang";
const REPO_NAME = "easynote";

/* 下载渠道：顺序无关，运行时自动测速选最快；任一失效自动跳过 / 回退。
 * transform(u) 把「官方下载地址」改写成该渠道可访问的地址（镜像多为在前面拼域名）。 */
const DOWNLOAD_CHANNELS = [
  { name: "GitHub 官方", transform: function (u) { return u; } },
  { name: "ghproxy.com", transform: function (u) { return "https://ghproxy.com/" + u; } },
  { name: "mirror.ghproxy.com", transform: function (u) { return "https://mirror.ghproxy.com/" + u; } },
  { name: "github.bibaiyu.com", transform: function (u) { return "https://github.bibaiyu.com/" + u; } },
];

function shellQuote(s) {
  return '"' + String(s).replace(/"/g, '\\"') + '"';
}

/* 跟随重定向的 GET（最多 5 跳）。onResponse(res) 在最终响应上回调。 */
function httpGetFollow(url, options, onResponse, depth) {
  depth = depth || 0;
  const lib = url.startsWith("https") ? https : http;
  return lib.get(url, options, function (res) {
    if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location && depth < 5) {
      const next = new URL(res.headers.location, url).toString();
      res.resume();
      return httpGetFollow(next, options, onResponse, depth + 1);
    }
    onResponse(res);
  });
}

/* 单渠道测速：对安装包做 512KB 的范围请求，统计吞吐（KB/s）。并发跑，互不阻塞。 */
function speedTestChannel(channel, sampleUrl, timeoutMs) {
  return new Promise(function (resolve) {
    const start = Date.now();
    let bytes = 0;
    let settled = false;
    const finish = function (ok, kbps) {
      if (settled) return;
      settled = true;
      resolve({ name: channel.name, ok: ok, kbps: kbps || 0 });
    };
    const req = httpGetFollow(
      channel.transform(sampleUrl),
      { headers: { Range: "bytes=0-524287", "User-Agent": "easynote-updater" } },
      function (res) {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return finish(false);
        res.on("data", function (c) {
          bytes += c.length;
          if (bytes >= 524288) {
            try { res.destroy(); } catch (e) {}
            finish(true, bytes / 1024 / Math.max(0.001, (Date.now() - start) / 1000));
          }
        });
        res.on("end", function () { finish(true, bytes / 1024 / Math.max(0.001, (Date.now() - start) / 1000)); });
        res.on("error", function () { finish(false); });
      }
    );
    req.on("error", function () { finish(false); });
    req.setTimeout(timeoutMs, function () {
      try { req.destroy(); } catch (e) {}
      finish(false);
    });
  });
}

/* 按当前系统挑选 Release 资产。Linux 优先 AppImage（可自更新），没有再退 deb。 */
function pickAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const platform = process.platform;
  if (platform === "darwin") return assets.find(function (a) { return /\.dmg$/i.test(a.name); }) || null;
  if (platform === "win32") return assets.find(function (a) { return /\.exe$/i.test(a.name); }) || null;
  const appimg = assets.find(function (a) { return /\.AppImage$/i.test(a.name); });
  if (appimg) return appimg;
  return assets.find(function (a) { return /\.deb$/i.test(a.name); }) || null;
}

/* 取指定版本 Release 的资产列表（含 browser_download_url）。 */
async function fetchReleaseAssets(version) {
  const tag = "v" + String(version).replace(/^v/i, "");
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 12000);
  try {
    const res = await fetch("https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + "/releases/tags/" + tag, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "easynote-updater" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.assets ? data.assets : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* 带进度下载：依次尝试 orderedUrls（测速排序后的渠道），失败自动切下一个。 */
function downloadAsset(orderedUrls, dest, onProgress) {
  return new Promise(function (resolve, reject) {
    let idx = 0;
    let settled = false;
    const cleanup = function () { try { fs.unlinkSync(dest); } catch (e) {} };

    const tryNext = function () {
      if (settled) return;
      if (idx >= orderedUrls.length) {
        settled = true;
        return reject(new Error("所有下载渠道均失败"));
      }
      const url = orderedUrls[idx++];
      let file;
      try { file = fs.createWriteStream(dest); } catch (e) { settled = true; return reject(e); }
      let bytes = 0;
      let total = 0;

      const req = httpGetFollow(url, { headers: { "User-Agent": "easynote-updater" } }, function (res) {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          try { file.destroy(); } catch (e) {}
          cleanup();
          return tryNext();
        }
        total = parseInt(res.headers["content-length"] || "0", 10);
        const t0 = Date.now();
        res.on("data", function (c) {
          bytes += c.length;
          const pct = total ? Math.min(100, Math.floor((bytes / total) * 100)) : 0;
          const kbps = bytes / 1024 / Math.max(0.001, (Date.now() - t0) / 1000);
          onProgress({ percent: pct, bytes: bytes, total: total, speedKbps: Math.round(kbps) });
        });
        res.pipe(file);
        file.on("finish", function () {
          file.close(function () {
            if (settled) return;
            settled = true;
            resolve(dest);
          });
        });
        file.on("error", function () {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("写入临时文件失败"));
        });
      });
      req.on("error", function () {
        if (settled) return;
        try { file.destroy(); } catch (e) {}
        cleanup();
        tryNext();
      });
      req.setTimeout(30000, function () {
        if (settled) return;
        try { req.destroy(); file.destroy(); } catch (e) {}
        cleanup();
        tryNext();
      });
    };

    tryNext();
  });
}

/* ============ 各平台安装（均会先关闭旧客户端再安装） ============ */

function installWin(filePath) {
  // 退出旧客户端，再启动 NSIS 安装向导（oneClick:false 是向导式，旧进程已退出不会锁文件）
  try { spawn(filePath, [], { detached: true, stdio: "ignore" }).unref(); } catch (e) {}
  setTimeout(function () { app.exit(0); }, 400);
}

function installMac(dmgPath) {
  execFile("hdiutil", ["attach", "-nobrowse", "-noautoopen", dmgPath], function (err, stdout) {
    if (err) {
      // 挂载失败：退而求其次，打开 dmg 让用户自己拖
      try { execFile("open", [dmgPath]); } catch (e) {}
      setTimeout(function () { app.exit(0); }, 600);
      return;
    }
    const m = String(stdout).match(/\/Volumes\/[^\n]+/);
    const mount = m ? m[0].trim() : null;
    if (!mount) { try { execFile("open", [dmgPath]); } catch (e) {} app.exit(0); return; }
    const srcApp = path.join(mount, "简易笔记.app");
    const destApp = "/Applications/简易笔记.app";
    const cmd = "rm -rf " + shellQuote(destApp) + " && cp -R " + shellQuote(srcApp) + " " + shellQuote(destApp);
    const runSh = function (c, cb) { execFile("sh", ["-c", c], cb); };
    runSh(cmd, function (e) {
      if (e) {
        // 普通用户没权限写 /Applications，提权再试一次
        execFile("osascript", ["-e", 'do shell script ' + shellQuote(cmd) + " with administrator privileges"], function (e2) {
          detachAndRelaunch(mount, e2);
        });
      } else {
        detachAndRelaunch(mount, null);
      }
    });
  });
}

function detachAndRelaunch(mount, err) {
  execFile("hdiutil", ["detach", mount, "-force"], function () {});
  if (err) {
    try { execFile("open", ["/Applications/简易笔记.app"]); } catch (e) {}
  } else {
    try { execFile("open", ["/Applications/简易笔记.app"]); } catch (e) {}
  }
  setTimeout(function () { app.exit(0); }, 600);
}

function installLinux(filePath, name) {
  const appImage = process.env.APPIMAGE;
  if (/\.AppImage$/i.test(name) && appImage) {
    // 直接覆盖当前 AppImage 文件后重启（AppImage 运行时是解包后的副本，覆盖本体安全）
    fs.copyFile(filePath, appImage, function (e) {
      if (e) {
        execFile("pkexec", ["cp", "-f", filePath, appImage], function (e2) {
          if (e2) { try { execFile("xdg-open", [filePath]); } catch (x) {} return app.exit(0); }
          relaunchAppImage(appImage);
        });
        return;
      }
      fs.chmod(appImage, 0o755, function () { relaunchAppImage(appImage); });
    });
    return;
  }
  // deb / rpm：交给系统包管理器（需密码），装完退出，用户自行重开
  const args = /\.deb$/i.test(name) ? ["dpkg", "-i", filePath] : ["rpm", "-i", filePath];
  try { execFile("pkexec", args, function () {}); } catch (e) {}
  setTimeout(function () { app.exit(0); }, 400);
}

function relaunchAppImage(appImage) {
  try { spawn(appImage, [], { detached: true, stdio: "ignore" }).unref(); } catch (e) {}
  setTimeout(function () { app.exit(0); }, 500);
}

function installAsset(name, filePath) {
  const platform = process.platform;
  if (platform === "win32") return installWin(filePath);
  if (platform === "darwin") return installMac(filePath);
  return installLinux(filePath, name);
}

/* ============ 入口：检测 → 测速 → 下载 → 安装 ============ */
async function downloadAndInstall(opts) {
  const onStatus = opts.onStatus || function () {};
  const version = opts.version;
  if (!version) { onStatus({ phase: "error", message: "未知版本号" }); return; }

  onStatus({ phase: "resolve", message: "正在获取安装包信息…" });
  const assets = await fetchReleaseAssets(version);
  const asset = pickAsset(assets);
  if (!asset || !asset.browser_download_url) {
    onStatus({ phase: "error", message: "找不到匹配当前系统的安装包" });
    return;
  }
  const baseUrl = asset.browser_download_url;

  // 多渠道测速
  onStatus({ phase: "speedtest", message: "正在测速，选择最快下载源…" });
  const results = await Promise.all(DOWNLOAD_CHANNELS.map(function (ch) {
    return speedTestChannel(ch, baseUrl, 8000);
  }));
  const ranked = results.filter(function (r) { return r.ok; }).sort(function (a, b) { return b.kbps - a.kbps; });

  let channels;
  if (ranked.length) {
    channels = ranked;
  } else {
    // 测速全失败：至少走官方渠道
    channels = [{ name: DOWNLOAD_CHANNELS[0].name }];
  }
  const orderedUrls = channels.map(function (c) {
    const ch = DOWNLOAD_CHANNELS.find(function (x) { return x.name === c.name; }) || DOWNLOAD_CHANNELS[0];
    return ch.transform(baseUrl);
  });
  const bestName = channels[0].name;

  onStatus({ phase: "download", channel: bestName, percent: 0, message: "开始下载" });
  const tmp = path.join(app.getPath("temp"), asset.name);
  try {
    await downloadAsset(orderedUrls, tmp, function (p) {
      onStatus({
        phase: "download",
        channel: bestName,
        percent: p.percent,
        bytes: p.bytes,
        total: p.total,
        speedKbps: p.speedKbps,
      });
    });
  } catch (e) {
    onStatus({ phase: "error", message: "下载失败：" + ((e && e.message) || e) });
    return;
  }

  onStatus({ phase: "install", message: "下载完成，正在安装…" });
  installAsset(asset.name, tmp);
  // 安装流程会自行退出应用，这里不再 resolve
}

module.exports = {
  downloadAndInstall: downloadAndInstall,
  DOWNLOAD_CHANNELS: DOWNLOAD_CHANNELS,
  pickAsset: pickAsset,
  downloadAsset: downloadAsset,
};
