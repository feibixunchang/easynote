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
const crypto = require("crypto");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { app, shell } = require("electron");

const REPO_OWNER = "feibixunchang";
const REPO_NAME = "easynote";
const RELEASES_PAGE = "https://github.com/" + REPO_OWNER + "/" + REPO_NAME + "/releases";

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

/* AppleScript 字符串字面量转义（用于 do shell script … with administrator privileges） */
function appleQuote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
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

/* ---- 产物命名规则（与 package.json 的 build.artifactName 完全一致）----
 *   win(nsis) : easynote-Setup-${version}.exe
 *   mac(dmg)  : easynote-${version}.dmg
 *   linux     : easynote-${version}-${arch}.AppImage / easynote-${version}-amd64.deb
 * 有了这条规则，GitHub API 不可达时也能直接拼出下载地址（见 resolveAsset）。 */
function assetNameCandidates(version) {
  const v = String(version).replace(/^v/i, "");
  const platform = process.platform;
  if (platform === "darwin") return ["easynote-" + v + ".dmg"];
  if (platform === "win32") return ["easynote-Setup-" + v + ".exe"];
  return ["easynote-" + v + "-x86_64.AppImage", "easynote-" + v + "-amd64.deb"];
}

function releaseDownloadUrl(name, version) {
  const v = String(version).replace(/^v/i, "");
  return "https://github.com/" + REPO_OWNER + "/" + REPO_NAME + "/releases/download/v" + v + "/" + name;
}

/* 带超时的 JSON 请求，失败返回 null（不抛异常）。 */
async function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 10000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "easynote-updater" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && Array.isArray(data.assets) ? data.assets : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* 探测资产是否存在：Range 只取 1 字节，不下载整个安装包。 */
function probeAsset(url) {
  return new Promise(function (resolve) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); resolve(false); }, 9000);
    fetch(url, {
      headers: { Range: "bytes=0-0", "User-Agent": "easynote-updater" },
      signal: ctrl.signal,
      redirect: "follow",
    }).then(function (res) {
      clearTimeout(timer);
      resolve(!!res && (res.status === 200 || res.status === 206));
    }).catch(function () {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/* 取指定版本 Release 的资产列表（含 browser_download_url）。
 * 官方 API 之外再走一遍下载镜像（镜像同时代理 api.github.com）。
 * 注意：国内网络下 api.github.com 常常连不通（而 github.com 本身是通的），
 * 所以这里只是兜底，主路径是下面的直链。 */
async function fetchReleaseAssets(version) {
  const tag = "v" + String(version).replace(/^v/i, "");
  const apiUrl = "https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + "/releases/tags/" + tag;
  const urls = [apiUrl].concat(DOWNLOAD_CHANNELS.slice(0, 2).map(function (ch) { return ch.transform(apiUrl); }));
  for (let i = 0; i < urls.length; i++) {
    const assets = await fetchJson(urls[i], i === 0 ? 9000 : 5000);
    if (assets) return assets;
  }
  return null;
}

/* 依次探测候选资产名是否真实存在（只读响应头，不下载文件本体）。 */
async function probeCandidates(names, version) {
  for (let i = 0; i < names.length; i++) {
    const url = releaseDownloadUrl(names[i], version);
    if (await probeAsset(url)) {
      return { name: names[i], browser_download_url: url };
    }
  }
  return null;
}

/* 解析出当前系统该用的安装包。
 * 返回 { asset, viaApi } —— viaApi=false 表示 API 不可用、靠命名规则拼出来的直链。
 * 直链与 API 并行发起：直链只要 1 字节的响应头，通常 1-2 秒就有结果，
 * 不必等 API 超时，这也是"提示有更新却下载不了"的根治点。 */
async function resolveAsset(version) {
  const v = String(version).replace(/^v/i, "");
  const names = assetNameCandidates(v);
  const apiPromise = fetchReleaseAssets(v).catch(function () { return null; });
  const direct = await probeCandidates(names, v);
  if (direct) return { asset: direct, viaApi: false };
  const assets = await apiPromise;
  if (assets) {
    const picked = pickAsset(assets);
    if (picked && picked.browser_download_url) return { asset: picked, viaApi: true };
    return { asset: null, viaApi: true };
  }
  // API 与直链都不通：照样给出第一个候选，后面的多渠道下载还会再试一次
  return { asset: { name: names[0], browser_download_url: releaseDownloadUrl(names[0], v) }, viaApi: false };
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

/* ============ 各平台安装 ============
 * 统一返回 Promise<{ ok, message?, error? }>：
 *   ok=true  → 安装程序已交给系统（调用方随后退出应用，让安装器能替换正在运行的文件）
 *   ok=false → 不要退出应用！把 message 回给界面，并给「打开文件夹 / 下载页」手动出口。
 * 之前的问题：安装启动不可靠 + 失败也照样 app.exit(0) → 用户看到"进度条走完 → 应用自己关了 →
 * 什么都没装"，只能自己去发布页重新下载。 */
function quitSoon(ms) {
  setTimeout(function () { app.exit(0); }, ms || 800);
}

/* -- 等本进程真正退出，再执行安装动作 --
 * NSIS 安装器会检测同名程序是否在运行，macOS 的运行中 .app 也删不掉；
 * 而 Windows 默认「关闭到托盘」，点 X 只隐藏窗口、进程还在
 * -> 安装时弹出「简易笔记无法关闭，请手动关闭它，然后单击重试以继续」。
 * 做法：先起一个游离进程盯住我们的 PID，等我们退出后再动手，从根上消除竞态。 */
function spawnAfterExitPosix(cmd) {
  const pid = process.pid;
  return spawn("/bin/sh", ["-c", "while kill -0 " + pid + " 2>/dev/null; do sleep 0.2; done; " + cmd],
    { detached: true, stdio: "ignore" });
}
function spawnAfterExitWin(exePath) {
  const pid = process.pid;
  const safe = String(exePath).split(String.fromCharCode(39)).join(String.fromCharCode(39, 39));
  const ps = "Wait-Process -Id " + pid + " -ErrorAction SilentlyContinue; "
    + "Start-Sleep -Milliseconds 800; Start-Process -FilePath " + String.fromCharCode(39) + safe + String.fromCharCode(39);
  return spawn("powershell",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
    { detached: true, stdio: "ignore" });
}

function installWin(filePath) {
  // 必须"先退出、再安装"：否则 NSIS 会弹「无法关闭，请手动关闭它」。
  // ① 首选 PowerShell 盯 PID，等本进程消失后再拉起安装向导
  try {
    spawnAfterExitWin(filePath).unref();
    return { ok: true, message: "应用即将退出，安装向导会自动打开" };
  } catch (e) { /* 继续尝试 ② */ }
  // ② 退回 detached cmd：延时约 4 秒（足够我们退出）后再启动安装向导
  try {
    const q = '"' + String(filePath).replace(/"/g, String.fromCharCode(39, 39)) + '"';
    const comspec = process.env.ComSpec || "cmd.exe";
    spawn(comspec, ["/c", "ping -n 5 127.0.0.1 >nul && " + q], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, message: "应用即将退出，安装向导会自动打开" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function installMac(dmgPath) {
  return new Promise(function (resolve) {
    execFile("hdiutil", ["attach", "-nobrowse", "-noautoopen", dmgPath], function (err, stdout) {
      const fallbackOpen = function (why) {
        // 挂载/拷贝失败也别静默：直接打开安装包，让用户拖进「应用程序」即可完成更新
        try { shell.openPath(dmgPath); } catch (e) {}
        resolve({ ok: false, error: why, message: "已为你打开安装包，请把「简易笔记」拖进「应用程序」完成更新" });
      };
      if (err) return fallbackOpen("dmg 挂载失败");
      const m = String(stdout).match(/\/Volumes\/[^\n]+/);
      const mount = m ? m[0].trim() : null;
      if (!mount) return fallbackOpen("未找到挂载点");
      const srcApp = path.join(mount, "简易笔记.app");
      const destApp = "/Applications/简易笔记.app";
      // 旧客户端必须先退出才能替换（运行中的 app 删不掉），交给独立 shell 延迟执行
      const plain = "rm -rf " + shellQuote(destApp) + " && cp -R " + shellQuote(srcApp) + " " + shellQuote(destApp);
      const apple = 'do shell script ' + appleQuote(plain) + " with administrator privileges";
      // 同样"等我们退出后再替换"：运行中的 .app 删不掉（Text file busy）
      const script =
        "(" + plain + ") 2>/dev/null || osascript -e " + shellQuote(apple) + "; " +
        "hdiutil detach " + shellQuote(mount) + " -force >/dev/null 2>&1; " +
        "open " + shellQuote(destApp) + " 2>/dev/null || open " + shellQuote(srcApp);
      try {
        spawnAfterExitPosix(script).unref();
        resolve({ ok: true, message: "应用即将退出，更新会在后台完成并自动重新打开" });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  });
}

function installLinux(filePath, name) {
  const appImage = process.env.APPIMAGE;
  const isAppImage = /\.AppImage$/i.test(name);
  const isDeb = /\.deb$/i.test(name);

  // 提权执行 + 检查结果：以前直接 spawn pkexec 不看返回 —— 授权被取消/无 polkit 时
  // 会"静默失败"（应用退出了，却什么都没发生，用户只能自己去发布页重下）。
  const runPrivileged = function (args, okMsg, failMsg) {
    return new Promise(function (resolve) {
      let settled = false;
      const done = function (ok, message) {
        if (settled) return;
        settled = true;
        resolve(ok ? { ok: true, message: message || okMsg } : { ok: false, error: "pkexec failed", message: message || failMsg });
      };
      let child;
      try {
        child = spawn("pkexec", args, { detached: true, stdio: "ignore" });
      } catch (e) {
        return done(false, failMsg);
      }
      child.on("error", function () { done(false, "系统没有可用的安装器，也没有 pkexec。" + failMsg); });
      child.on("exit", function (code) {
        if (code && code !== 0) done(false, "提权安装被取消或失败（code " + code + "）。" + failMsg);
        else done(true);
      });
      // 1.2 秒没退出 → 认为授权框/安装流程已经开始（pkexec 会一直等到安装结束）
      setTimeout(function () { done(true); }, 1200);
      try { child.unref(); } catch (e) {}
    });
  };

  // ① 正在以 AppImage 运行：等我们退出后覆盖本体并自动启动（先确认有写权限，
  //    没写权限就**不要**先退出应用，改走下面的授权流程）
  if (isAppImage && appImage) {
    try {
      fs.accessSync(appImage, fs.constants.W_OK);
      const cmd = "cp -f " + shellQuote(filePath) + " " + shellQuote(appImage)
        + " && chmod 755 " + shellQuote(appImage)
        + " && (" + shellQuote(appImage) + " >/dev/null 2>&1 &)";
      spawnAfterExitPosix(cmd).unref();
      return Promise.resolve({ ok: true, message: "应用即将退出，新版本会自动覆盖并启动" });
    } catch (e) {
      // 无写权限 → 用 pkexec 复制替换（并检查结果）
      return runPrivileged(
        ["/bin/sh", "-c", "cp -f " + shellQuote(filePath) + " " + shellQuote(appImage)
          + " && chmod 755 " + shellQuote(appImage)],
        "已请求管理员授权替换，替换完成后请手动重启应用",
        "已为你保留安装包，可手动替换后重启。"
      );
    }
  }

  // ② deb / rpm：首选交给系统「软件安装器」打开 —— 有可见的安装界面，
  //    且它是独立进程，不会出现"应用退出了但什么都没发生"
  const args = isDeb ? ["dpkg", "-i", filePath] : ["rpm", "-i", filePath];
  return new Promise(function (resolve) {
    let opened = "";
    try { opened = shell.openPath(filePath) || ""; } catch (e) { opened = String((e && e.message) || e); }
    if (!opened) {
      resolve({
        ok: true,
        message: "已用系统安装器打开安装包，请在弹出的窗口里点「安装」完成更新，装好后重新打开应用",
      });
      return;
    }
    // ③ 系统没有关联安装器 → 退回 pkexec（并检查结果，失败就不退出应用，给出手动出口）
    runPrivileged(args, "已请求管理员授权安装，完成后请重新打开应用",
      "安装包已下载完成，可手动安装（点「打开文件夹」）。").then(resolve);
  });
}
function startInstall(name, filePath) {
  try {
    if (process.platform === "win32") return Promise.resolve(installWin(filePath));
    if (process.platform === "darwin") return installMac(filePath);
    return installLinux(filePath, name);
  } catch (e) {
    return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
  }
}

/* ============ 入口：检测 → 测速 → 下载 → 安装 ============ */
/* ============ 完整性校验（防镜像投毒 / 下载被篡改）============
 * 思路：安装包的官方 sha256 从 GitHub Releases API 的资产 digest 字段获取；
 *      下载完成后在本地重新计算 sha256 并比对。
 *      这样即使实际下载走了第三方镜像，也能保证拿到的就是官方那一份。
 *      拿不到 digest（API 不通 / 资产是旧上传没有 digest）时，不静默通过，
 *      而是明确提示「未能校验完整性」，把判断权交给用户。 */
function sha256File(file) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", function (chunk) { hash.update(chunk); });
    stream.on("end", function () { resolve(hash.digest("hex")); });
    stream.on("error", reject);
  });
}

/* 取指定版本某个资产的官方 sha256（返回小写 64 位 hex；拿不到则 null） */
async function fetchOfficialDigest(version, assetName) {
  const assets = await fetchReleaseAssets(version).catch(function () { return null; });
  if (!assets) return null;
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    if (!a || a.name !== assetName) continue;
    if (typeof a.digest === "string" && /^sha256:[0-9a-f]{64}$/i.test(a.digest)) {
      return a.digest.slice(7).toLowerCase();
    }
  }
  return null;
}

async function downloadAndInstall(opts) {
  const onStatus = opts.onStatus || function () {};
  const version = opts.version;
  if (!version) { onStatus({ phase: "error", message: "未知版本号" }); return; }

  onStatus({ phase: "resolve", message: "正在获取安装包信息…" });
  const resolved = await resolveAsset(version);
  if (!resolved || !resolved.asset || !resolved.asset.browser_download_url) {
    onStatus({
      phase: "error",
      message: "获取安装包信息失败：请检查网络后重试，或到 " + RELEASES_PAGE + " 手动下载",
    });
    return;
  }
  const asset = resolved.asset;
  if (!resolved.viaApi) {
    onStatus({ phase: "resolve", message: "GitHub 接口不通，已改用直链下载…" });
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
    onStatus({ phase: "error", message: "下载失败：" + ((e && e.message) || e) + "；可到 " + RELEASES_PAGE + " 手动下载" });
    return;
  }

  // —— 完整性校验：下载完先验 sha256，再安装 ——
  onStatus({ phase: "verify", message: "正在校验安装包完整性…" });
  let officialDigest = null;
  try { officialDigest = await fetchOfficialDigest(version, asset.name); } catch (e) {}
  if (officialDigest) {
    let actual = "";
    try { actual = await sha256File(tmp); } catch (e) { actual = ""; }
    if (actual !== officialDigest) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      onStatus({
        phase: "error",
        message: "安装包校验未通过（sha256 不匹配），已丢弃。可能是下载被篡改或文件损坏；" +
          "请重试，或到 " + RELEASES_PAGE + " 手动下载",
      });
      return;
    }
    onStatus({ phase: "verify", message: "完整性校验通过 ✓" });
  } else {
    onStatus({
      phase: "verify",
      message: "提示：未能获取官方 sha256（GitHub 接口不通），本次无法校验完整性；" +
        "若不放心可到 " + RELEASES_PAGE + " 手动下载",
    });
  }

  onStatus({ phase: "install", message: "下载完成，正在启动安装程序…" });
  const ir = await startInstall(asset.name, tmp);
  if (ir && ir.ok) {
    onStatus({ phase: "install", message: (ir.message || "安装程序已启动") + "；应用即将退出…" });
    quitSoon(800); // 快速退出：安装动作由"盯 PID 的游离进程"在我们消失后接力
  } else {
    // 关键：自动安装没起来就别退出应用，把安装包位置与下载页出口交给界面
    onStatus({
      phase: "manual",
      file: tmp,
      error: (ir && ir.error) || "",
      message: (ir && ir.message) || "自动安装未能启动。安装包已下载完成，可手动安装。",
    });
  }
  // 安装交给系统后由 quitSoon 退出应用，这里不再 resolve
}

module.exports = {
  downloadAndInstall: downloadAndInstall,
  DOWNLOAD_CHANNELS: DOWNLOAD_CHANNELS,
  pickAsset: pickAsset,
  downloadAsset: downloadAsset,
  // 以下为测试用导出
  resolveAsset: resolveAsset,
  fetchReleaseAssets: fetchReleaseAssets,
  assetNameCandidates: assetNameCandidates,
  releaseDownloadUrl: releaseDownloadUrl,
  sha256File: sha256File,
  fetchOfficialDigest: fetchOfficialDigest,
  RELEASES_PAGE: RELEASES_PAGE,
  startInstall: startInstall,
};
