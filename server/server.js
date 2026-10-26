/* ============ 简易笔记 · 云同步服务端 ============
 * 纯本地/自托管方案：Express + JWT + bcrypt + 文件存储
 * 启动：node server.js   （默认 http://localhost:3000）
 * 环境变量：PORT（端口）、JWT_SECRET（令牌密钥，生产环境务必修改）
 */
"use strict";

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
// 服务端版本（不跟桌面端版本号走）：客户端「同步诊断」会读它，
// 方便判断连的是不是旧版服务端（例如不支持增量同步的老版本）。
const SERVER_VERSION = "1.4.0";
const SECRET = process.env.JWT_SECRET || "simplenote-zh-dev-secret-change-me";
// 请求体上限：客户端「一键修复」会把图片转成 base64 内嵌进笔记，同步时整批笔记
// （含内嵌图片）可能达数 MB~数十 MB，Express 默认 100kb 会返回 413 导致同步失败。
const BODY_LIMIT = process.env.BODY_LIMIT || "100mb";

// -------- 自托管部署的安全 / 资源保护开关（全部可用环境变量覆盖）--------
// 注册策略：本软件供他人自行部署，每个人用自己的实例同步自己的数据（数据不互通），
// 所以服务端默认不需要长期开放注册。
//   - 显式设置 ALLOW_REGISTRATION=true / false 时以其为准；
//   - 未设置时采用「引导」策略：只有第一个账号可以注册，建好后自动关闭。
//     这样新部署的人能创建自己的账号，之后再无人能注册进来。
const ALLOW_REGISTRATION_ENV = process.env.ALLOW_REGISTRATION;
function registrationAllowed(userCount) {
  if (ALLOW_REGISTRATION_ENV !== undefined && String(ALLOW_REGISTRATION_ENV) !== "") {
    return String(ALLOW_REGISTRATION_ENV).toLowerCase() !== "false";
  }
  return userCount === 0; // 仅在尚无账号时允许注册首个账号
}
// 最多注册用户数（自托管磁盘有限，防止被批量注册塞满）
const MAX_USERS = parseInt(process.env.MAX_USERS || "100", 10);
// 单用户笔记存储配额（MB），0 表示不限。自托管磁盘有限时的护栏，防止单账号意外占满。
const USER_QUOTA_MB = parseInt(process.env.USER_QUOTA_MB || "500", 10);
const USER_QUOTA_BYTES = USER_QUOTA_MB > 0 ? USER_QUOTA_MB * 1024 * 1024 : 0;
// 登录失败达到该次数后冷却（防暴力破解 / 撞库）
const LOGIN_MAX_FAILS = parseInt(process.env.LOGIN_MAX_FAILS || "5", 10);
const LOGIN_LOCK_MS = parseInt(process.env.LOGIN_LOCK_MIN || "15", 10) * 60 * 1000;
// 单 IP 每小时最多注册账号数（防机器人批量注册）
const REGISTER_MAX_PER_HOUR = parseInt(process.env.REGISTER_MAX_PER_HOUR || "5", 10);
// bcrypt 强度（成本因子），越高越耐离线暴力破解，登录时略慢
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);
// 注册密码最小长度
const MIN_PASSWORD_LEN = parseInt(process.env.MIN_PASSWORD_LEN || "8", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
// 网页版（Docker 容器里随服务端一起托管）的静态资源目录，可用 WEB_ROOT 覆盖。
// 默认指向「服务端同级目录下的 web/」：镜像里会把浏览器版 UI（index.html / app.js / styles.css）放这里。
const WEB_DIR = process.env.WEB_ROOT || path.join(__dirname, "web");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const NOTES_DIR = path.join(DATA_DIR, "notes");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(NOTES_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");

/* ============ 存储层工具（数据安全）============ */
// 原子写 + 保留一份 .bak：先写 .tmp 再 rename（同目录 rename 是原子操作）。
// 之前直接 fs.writeFileSync 覆盖：若写到一半进程被杀 / 断电，JSON 会被截断，
// 而解析失败时 loadNotes 会 return {}，等于该用户整库笔记瞬间"消失"。这里彻底避免。
function writeFileAtomic(file, str) {
  var tmp = file + ".tmp";
  fs.writeFileSync(tmp, str);
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch (e) {}
  fs.renameSync(tmp, file);
}
// 读取 JSON；主文件损坏时自动回退到 .bak（配合上面的原子写，抗截断）
function readJsonWithBak(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  try {
    var bak = JSON.parse(fs.readFileSync(file + ".bak", "utf8"));
    console.warn("[easynote] " + file + " 解析失败，已用 .bak 恢复");
    return bak;
  } catch (e2) { return null; }
}
// 把解析出来的普通对象转成"无原型字典"：当 id / 用户名是 __proto__ 这类键时，
// 普通对象会发生原型污染（污染后 Object.keys 行为异常，甚至造成数据"消失"）。
function toDict(obj) {
  var d = Object.create(null);
  if (obj && typeof obj === "object") {
    Object.keys(obj).forEach(function (k) { d[k] = obj[k]; });
  }
  return d;
}
// 合法笔记 id：客户端 uid() 生成（n_xxx）。只放行字母数字下划线连字符，挡掉
// __proto__ / 超长 / 带路径分隔符的 id，避免污染与脏数据入库。
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];
function isValidId(id) {
  if (typeof id !== "string" || !NOTE_ID_RE.test(id)) return false;
  // __proto__ / constructor / prototype 虽然也满足上面的字符集，但作为 Object 的键
  // 会触发原型污染（客户端把结果塞进普通对象时，笔记会"消失"），这里明确拒绝。
  return RESERVED_KEYS.indexOf(id) === -1;
}

/* ============ 单调入库时间戳（增量同步不丢数据的关键）============
 * 增量同步以"服务端入库时间"为游标。若直接用 Date.now()：两台设备在同一毫秒
 * 发生改动时，A 收到的 serverTime 可能已经 >= B 这次写库的时间，B 的这条改动
 * 就永远落在游标"之前" → 该设备永久漏同步。
 * 这里保证每次入库时间戳严格递增（同毫秒则 +1），游标取"已分配的最大时间戳"，
 * 于是"大于游标"的过滤永远不漏。 */
let lastStamp = 0;
function nextStamp() {
  var t = Date.now();
  if (t <= lastStamp) t = lastStamp + 1;
  lastStamp = t;
  return t;
}
// 启动时把时间戳底线抬到"已有数据的最大时间戳"之上（含重启前的旧数据 / 时钟偏快的数据）
function initStampFloor() {
  var max = Date.now();
  try {
    fs.readdirSync(NOTES_DIR).forEach(function (f) {
      if (!/\.json$/.test(f) || /\.(tmp|bak)$/.test(f)) return;
      var obj = readJsonWithBak(path.join(NOTES_DIR, f));
      if (!obj || typeof obj !== "object") return;
      Object.keys(obj).forEach(function (k) {
        var v = obj[k];
        var s = (v && typeof v === "object")
          ? (typeof v.storedAt === "number" ? v.storedAt : (v.modifiedDate || v.deletedDate || 0))
          : (typeof v === "number" ? v : 0);
        if (s > max) max = s;
      });
    });
  } catch (e) {}
  lastStamp = max;
}
initStampFloor();
// 响应里给客户端的游标：取已分配的最大时间戳（不回退，兼容老客户端的毫秒游标）
function cursorNow(since) {
  return Math.max(lastStamp, since || 0);
}
// 是否在用内置默认密钥（公网部署时是严重风险，启动会醒目告警）
const USING_DEFAULT_SECRET = !process.env.JWT_SECRET;

/* ============ 简易限速（进程内存，重启即清空）============
 * 目的：公网开放后防暴力破解（登录）与批量注册（注册）。
 * 若要多实例部署，请换成 Redis 等共享存储。 */
function clientIp(req) {
  // 部署在反向代理（Nginx/Caddy）后面时，必须取 X-Forwarded-For 的第一跳，
  // 否则所有请求都会被记成代理自己的 IP，限速等于失效。
  var xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  var xr = req.headers["x-real-ip"];
  if (xr) return String(xr).trim();
  return String((req.ip || (req.connection && req.connection.remoteAddress) || "unknown"));
}

const loginFails = new Map(); // key(ip 或 用户名) -> { count, until }
const registerHits = new Map(); // ip -> [时间戳]

function isLocked(key) {
  var rec = loginFails.get(key);
  if (!rec) return false;
  if (rec.until && Date.now() < rec.until) return true;
  if (rec.until && Date.now() >= rec.until) loginFails.delete(key); // 冷却结束自动解锁
  return false;
}
function noteLoginFail(key) {
  var rec = loginFails.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.until = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(key, rec);
}
function clearLoginFail(key) {
  loginFails.delete(key);
}
function tooManyRegisters(ip) {
  var now = Date.now();
  var arr = (registerHits.get(ip) || []).filter(function (t) { return now - t < 3600000; });
  arr.push(now);
  registerHits.set(ip, arr);
  return arr.length > REGISTER_MAX_PER_HOUR;
}
// 定期清理过期限速记录，避免长期运行内存缓慢增长
setInterval(function () {
  var now = Date.now();
  loginFails.forEach(function (v, k) {
    if (v.until && now >= v.until) loginFails.delete(k);
  });
  registerHits.forEach(function (v, k) {
    var arr = v.filter(function (t) { return now - t < 3600000; });
    if (arr.length) registerHits.set(k, arr); else registerHits.delete(k);
  });
}, 10 * 60 * 1000).unref();

function loadUsers() {
  return toDict(readJsonWithBak(USERS_FILE));
}
function saveUsers(u) {
  writeFileAtomic(USERS_FILE, JSON.stringify(u, null, 2));
}
function userNotesFile(u) {
  var p = path.join(NOTES_DIR, u + ".json");
  // 防御路径穿越：用户名含 / 或 .. 时，最终文件会跑出 NOTES_DIR，直接拒绝
  if (path.dirname(p) !== NOTES_DIR) {
    var err = new Error("BAD_USERNAME");
    err.code = "BAD_USERNAME";
    throw err;
  }
  return p;
}
function loadNotes(u) {
  var notes = toDict(readJsonWithBak(userNotesFile(u)));
  // 迁移：老数据没有 storedAt（服务端入库时间）。用"单调时间戳"补齐并立即落盘，
  // 避免每次读取都重新赋值导致游标抖动 / 老笔记被反复重发。
  var migrated = false;
  Object.keys(notes).forEach(function (k) {
    var n = notes[k];
    if (n && typeof n === "object" && typeof n.storedAt !== "number") {
      n.storedAt = nextStamp();
      migrated = true;
    }
  });
  if (migrated) { try { saveNotes(u, notes); } catch (e) {} }
  return notes;
}
function saveNotes(u, obj) {
  var json = JSON.stringify(obj);
  // 每用户存储配额：自托管（NAS）磁盘有限。公网开放注册 + 100mb 请求体上限下，
  // 若无配额，单用户反复塞入带图笔记就能把磁盘撑爆。
  if (USER_QUOTA_BYTES > 0 && Buffer.byteLength(json, "utf8") > USER_QUOTA_BYTES) {
    var err = new Error("QUOTA_EXCEEDED");
    err.code = "QUOTA_EXCEEDED";
    throw err;
  }
  writeFileAtomic(userNotesFile(u), json);
}
// 墓碑（已永久删除的笔记 ID）：跨端传播，防止其他设备把已被永久删除的笔记重新拉回来。
// 单独存一个文件，避免与 notes 对象混淆。
function userTombFile(u) {
  return path.join(NOTES_DIR, u + ".tomb.json");
}
function loadTombstones(u) {
  var t = readJsonWithBak(userTombFile(u));
  if (!t || typeof t !== "object" || Array.isArray(t)) return Object.create(null);
  return toDict(t);
}
function saveTombstones(u, obj) {
  writeFileAtomic(userTombFile(u), JSON.stringify(obj));
}
// 增量返回：游标之后新增/更新的墓碑 ID
function tombsSince(tombs, since) {
  var ids = [];
  Object.keys(tombs).forEach(function (id) {
    if ((tombs[id] || 0) > since) ids.push(id);
  });
  return ids;
}

// 鉴权中间件：校验 Bearer Token
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: "未授权" });
  try {
    req.user = jwt.verify(m[1], SECRET, { algorithms: ["HS256"] }).username;
    next();
  } catch (e) {
    return res.status(401).json({ error: "登录已过期，请重新登录" });
  }
}

const app = express();
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
// 请求体上限调到 100mb（可用 BODY_LIMIT 环境变量调整）：客户端「一键修复」会把图片
// 转成 base64 内嵌进笔记，同步时整批笔记（含内嵌图片）可能达数 MB~数十 MB，
// Express 默认 100kb 会返回 413。
app.use(express.json({ limit: BODY_LIMIT }));
// 请求日志：便于排查客户端（如 Mac/手机）是否连得上、请求是否到达
app.use(function (req, res, next) {
  var ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  console.log(
    new Date().toISOString() + " " + req.method + " " + req.originalUrl +
    " ip=" + ip + " origin=" + (req.headers.origin || "-")
  );
  next();
});

app.get("/api/health", (req, res) => {
  // 只暴露"够用"的信息：版本、是否还允许注册、账号数。
  // 客户端用它判断连通性 + 服务端新旧，不涉及任何用户数据。
  let users = 0;
  try {
    users = Object.keys(loadUsers()).length;
  } catch (e) {
    users = 0;
  }
  res.json({
    ok: true,
    server: "easynote-sync",
    version: SERVER_VERSION,
    users,
    registration: registrationAllowed(users),
  });
});

// 注册
app.post("/api/register", (req, res) => {
  // 先限流（廉价），避免被洪水请求打进来后才去做文件读写
  const ip = clientIp(req);
  if (tooManyRegisters(ip)) {
    return res.status(429).json({ error: "注册过于频繁，请稍后再试" });
  }
  const body = req.body || {};
  const username = (body.username || "").trim();
  const password = body.password || "";
  const users = loadUsers();
  // 注册开关按部署策略：默认仅允许创建首个账号，之后自动关闭；
  // 想让多人共用一个实例（例如家庭共享）时，设置 ALLOW_REGISTRATION=true。
  if (!registrationAllowed(Object.keys(users).length)) {
    return res.status(403).json({
      error: "当前服务未开放注册（自托管默认：仅允许创建首个账号）。如需开放，请设置 ALLOW_REGISTRATION=true",
    });
  }
  if (username.length < 2) return res.status(400).json({ error: "用户名至少 2 个字符" });
  if (username.length > 32) return res.status(400).json({ error: "用户名不能超过 32 个字符" });
  // 用户名会被用作数据文件名，必须挡掉路径分隔符 / 上跳 / 控制字符（防止路径穿越），
  // 以及会引发原型污染的名字。中文用户名不受影响，正常使用即可。
  if (/[\/\\]/.test(username) || username.indexOf("..") !== -1 ||
      /[\u0000-\u001f]/.test(username) || username === "." ||
      username === "__proto__" || username === "constructor" || username === "prototype") {
    return res.status(400).json({ error: "用户名包含不被允许的字符（不能含 / \\ .. 或控制字符）" });
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: "密码至少 " + MIN_PASSWORD_LEN + " 位（密码越强度越高，越难被破解）" });
  }
  if (Object.keys(users).length >= MAX_USERS) {
    return res.status(403).json({ error: "用户数量已达上限（" + MAX_USERS + "），请联系服务提供者" });
  }
  if (users[username]) return res.status(409).json({ error: "该用户名已被注册" });
  users[username] = { username: username, passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS) };
  saveUsers(users);
  const token = jwt.sign({ username: username }, SECRET, { expiresIn: "30d", algorithm: "HS256" });
  res.json({ token: token, username: username });
});

// 登录
app.post("/api/login", (req, res) => {
  const body = req.body || {};
  const username = (body.username || "").trim();
  const password = body.password || "";
  const ip = clientIp(req);
  // 来源 IP 已被锁：直接拒绝，挡单源洪水 / 暴力破解
  if (isLocked(ip)) {
    return res.status(429).json({ error: "登录失败次数过多，请 " + (LOGIN_LOCK_MS / 60000) + " 分钟后再试" });
  }
  const users = loadUsers();
  const u = users[username];
  if (!u || !bcrypt.compareSync(password, u.passwordHash)) {
    noteLoginFail(ip);
    if (username) noteLoginFail(username);
    // 账号被多个来源轮番尝试时同样冷却（挡分布式撞库）
    if (isLocked(username)) {
      return res.status(429).json({ error: "登录失败次数过多，请 " + (LOGIN_LOCK_MS / 60000) + " 分钟后再试" });
    }
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  // 密码正确 → 立即清锁放行。
  // 刻意不因"账号被锁"而拦住正确密码：否则攻击者只要知道用户名就能把主人反锁在门外（拒绝服务）。
  clearLoginFail(ip);
  clearLoginFail(username);
  const token = jwt.sign({ username: username }, SECRET, { expiresIn: "30d", algorithm: "HS256" });
  res.json({ token: token, username: username });
});

// 增量过滤：只返回"服务端入库时间"晚于游标的笔记。
// 注意不能用笔记的 modifiedDate 比较——那是客户端时间，通常早于同步时刻，
// 用服务端当前时间做游标会永久漏掉刚同步进来的修改。
function changedSince(list, since) {
  return list.filter(function (n) {
    var at = n.storedAt;
    if (typeof at !== "number") at = n.modifiedDate || n.deletedDate || 0;
    return at > since;
  });
}

// 拉取笔记：带 ?since=<毫秒时间戳> 时只返回该时刻之后入库的笔记（增量同步），
// 否则返回全部（兼容老客户端 / 首次同步）。serverTime 供客户端校准下一次的 since 游标。
app.get("/api/notes", auth, (req, res) => {
  var since = parseInt(req.query.since, 10) || 0;
  var notes = loadNotes(req.user);
  var all = Object.keys(notes).map((k) => notes[k]);
  var list = since > 0 ? changedSince(all, since) : all;
  var tombs = loadTombstones(req.user);
  var removed = since > 0 ? tombsSince(tombs, since) : Object.keys(tombs);
  res.json({ notes: list, removed: removed, serverTime: cursorNow(since), total: all.length });
});

// 永久删除：客户端把要彻底删除的笔记 ID 上报，服务端删除笔记并记入墓碑。
// 其他设备下一次同步会收到 removed，从而把已被永久删除的笔记从本地清掉（跨端一致）。
app.post("/api/notes/purge", auth, (req, res) => {
  const raw = (req.body && req.body.ids) || [];
  if (!Array.isArray(raw) || !raw.length) return res.json({ ok: true, removed: [] });
  // 只接受合法 id，并限制单次数量（防脏数据 / 请求过大）
  const ids = raw.filter(isValidId).slice(0, 5000);
  if (!ids.length) return res.json({ ok: true, removed: [] });
  const store = loadNotes(req.user);
  const tombs = loadTombstones(req.user);
  const now = nextStamp(); // 墓碑时间戳也用单调时间戳（供"删除后新修改才可复活"判定）
  var changed = false;
  ids.forEach((id) => {
    if (store[id]) { delete store[id]; changed = true; }
    tombs[id] = now;
  });
  if (changed) saveNotes(req.user, store);
  saveTombstones(req.user, tombs);
  res.json({ ok: true, removed: ids });
});

// 同步（推送 + 合并 + 返回增量或完整集合，按 modifiedDate 后写覆盖）。
// 请求体可带 since：只返回该时刻之后入库的笔记，实现"近实时同步"的轻量轮询。
app.post("/api/notes/sync", auth, (req, res) => {
  const rawIncoming = (req.body && req.body.notes) || [];
  const incoming = Array.isArray(rawIncoming) ? rawIncoming.slice(0, 20000) : [];
  const since = parseInt(req.body && req.body.since, 10) || 0;
  const store = loadNotes(req.user);
  const tombs = loadTombstones(req.user);
  var changed = false, tombsChanged = false;
  const rejected = []; // 被墓碑挡下的 id：回给客户端，让本地也清掉
  incoming.forEach((n) => {
    if (!n || !isValidId(n.id)) return; // 脏 id / __proto__ 等一律拒收
    const tombAt = tombs[n.id];
    // 墓碑保护（关键）：只有当这次修改"晚于删除时间"（真正的撤销删除 / 重新创建）
    // 才允许清除墓碑；否则拒绝写入并把它放回 removed。
    // 否则：A 设备永久删除后，B 设备在收到墓碑前把自己的旧副本推上来，
    // 会把已删除的笔记"复活"到所有设备。
    if (tombAt && !((n.modifiedDate || 0) > tombAt)) { rejected.push(n.id); return; }
    const ex = store[n.id];
    if (!ex || (n.modifiedDate || 0) >= (ex.modifiedDate || 0)) {
      n.storedAt = nextStamp(); // 单调入库时间：增量游标以此为基准（严格递增，不漏）
      store[n.id] = n;
      changed = true;
      if (tombAt) { delete tombs[n.id]; tombsChanged = true; }
    }
  });
  if (changed) saveNotes(req.user, store);
  if (tombsChanged) saveTombstones(req.user, tombs);
  var all = Object.keys(store).map((k) => store[k]);
  var list = since > 0 ? changedSince(all, since) : all;
  var removed = since > 0 ? tombsSince(tombs, since) : Object.keys(tombs);
  rejected.forEach((id) => { if (removed.indexOf(id) === -1) removed.push(id); });
  res.json({ notes: list, removed: removed, serverTime: cursorNow(since), total: all.length });
});

// 统一错误输出为 JSON：否则 body-parser 的 413 会返回 HTML 错误页，
// 客户端只能显示「服务器返回错误 (413)」，用户看不懂该怎么处理。
app.use(function (err, req, res, next) {
  if (err && (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413)) {
    return res.status(413).json({
      error: "请求体过大：笔记内容（含内嵌图片）超过服务端限制。请减少内嵌图片，或调大 server.js 中 express.json 的 limit",
    });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求体不是合法的 JSON" });
  }
  if (err && err.code === "QUOTA_EXCEEDED") {
    return res.status(413).json({
      error:
        "存储空间已达上限（每个用户 " + USER_QUOTA_MB + "MB）。请删除部分笔记或减少内嵌图片；" +
        "服务端可用 USER_QUOTA_MB 环境变量调整配额",
    });
  }
  console.error("服务器错误:", err && (err.stack || err.message));
  res.status(err.status || err.statusCode || 500).json({ error: "服务器内部错误" });
});

// ============ 网页版（浏览器可访问的客户端）============
// 与服务端同源、同端口托管：浏览器打开 http://<host>:<PORT>/ 即为完整网页版，
// 登录同一个账户即可与桌面端 / 移动端实时同步（共用同一份 accounts + notes 数据）。
// PWA：manifest 与 service worker 用正确 MIME 提供（.webmanifest 默认类型不被识别，必须显式指定）
app.get(/^\/(manifest\.webmanifest|sw\.js)$/, function (req, res) {
  var isManifest = req.path === "/manifest.webmanifest";
  res.type(isManifest ? "application/manifest+json" : "application/javascript");
  res.sendFile(path.join(WEB_DIR, isManifest ? "manifest.webmanifest" : "sw.js"));
});

app.use(express.static(WEB_DIR, { index: "index.html" }));
// 兜底：非 /api 的未知路径返回 index.html（避免刷新/直链 404），API 不受影响
app.use(function (req, res, next) {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    var p = path.join(WEB_DIR, "index.html");
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  next();
});

app.listen(PORT, HOST, () => {
  const inDocker = require("fs").existsSync("/.dockerenv");
  const ips = getLocalIps();
  console.log("简易笔记云同步服务已启动");
  console.log("本机访问：http://localhost:" + PORT);
  console.log("网页版（浏览器访问，与桌面/移动端实时同步）：http://localhost:" + PORT + "/");
  if (inDocker) {
    console.log("检测到运行在 Docker 容器中：外部设备请使用【宿主机(NAS)】的局域网 IP 访问，");
    console.log("例如 http://192.168.1.100:" + PORT + "（请勿使用容器内部地址）");
  } else if (ips.length) {
    console.log("其他设备请用下面的「局域网地址」登录：");
    ips.forEach(function (ip) {
      console.log("   http://" + ip + ":" + PORT + "    （" + ipLabel(ip) + "）");
    });
  }
  console.log("监听地址：" + HOST + ":" + PORT + "（0.0.0.0 表示所有网卡，局域网均可访问）");
  if (USING_DEFAULT_SECRET) {
    console.warn("");
    console.warn("⚠️  安全提醒：正在使用内置默认 JWT_SECRET。");
    console.warn("    这意味着任何知道你服务地址的人都能伪造登录令牌、读取/篡改所有账号数据。");
    console.warn("    仅在本机 / 纯内网测试时可接受。公网部署请设置环境变量：");
    console.warn("      JWT_SECRET=<够长的随机串，例如 openssl rand -hex 32>");
    console.warn("");
  }
});

// 常见局域网网段优先，VPN/虚拟网卡地址排在后面；Docker 网桥段(172.17~172.31)不展示
function isDockerRange(ip) {
  return /^172\.(1[7-9]|2\d|3[01])\./.test(ip);
}
function getLocalIps() {
  const nets = require("os").networkInterfaces();
  const lan = [];
  const other = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if ((net.family === "IPv4" || net.family === 4) && !net.internal) {
        if (isDockerRange(net.address)) continue;
        if (/^(192\.168\.|10\.)/.test(net.address)) lan.push(net.address);
        else other.push(net.address);
      }
    }
  }
  return lan.concat(other);
}
function ipLabel(ip) {
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return "局域网，同WiFi设备可直接访问";
  return "虚拟网卡/VPN 地址，通常用于跨网远程";
}
