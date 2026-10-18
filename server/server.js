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
const SECRET = process.env.JWT_SECRET || "simplenote-zh-dev-secret-change-me";
// 请求体上限：客户端「一键修复」会把图片转成 base64 内嵌进笔记，同步时整批笔记
// （含内嵌图片）可能达数 MB~数十 MB，Express 默认 100kb 会返回 413 导致同步失败。
const BODY_LIMIT = process.env.BODY_LIMIT || "100mb";
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const NOTES_DIR = path.join(DATA_DIR, "notes");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(NOTES_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch (e) { return {}; }
}
function saveUsers(u) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
}
function userNotesFile(u) {
  return path.join(NOTES_DIR, u + ".json");
}
function loadNotes(u) {
  try {
    var notes = JSON.parse(fs.readFileSync(userNotesFile(u), "utf8")) || {};
    // 迁移：老数据没有 storedAt（服务端入库时间）。增量游标以它为准，
    // 用 modifiedDate 兜底并封顶为当前时间（防止客户端时钟偏快导致永远被重复返回）。
    var now = Date.now();
    Object.keys(notes).forEach(function (k) {
      var n = notes[k];
      if (n && typeof n.storedAt !== "number") {
        n.storedAt = Math.min(n.modifiedDate || n.deletedDate || 0, now);
      }
    });
    return notes;
  } catch (e) { return {}; }
}
function saveNotes(u, obj) {
  fs.writeFileSync(userNotesFile(u), JSON.stringify(obj));
}

// 鉴权中间件：校验 Bearer Token
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: "未授权" });
  try {
    req.user = jwt.verify(m[1], SECRET).username;
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

app.get("/api/health", (req, res) => res.json({ ok: true }));

// 注册
app.post("/api/register", (req, res) => {
  const body = req.body || {};
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (username.length < 2) return res.status(400).json({ error: "用户名至少 2 个字符" });
  if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位" });
  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: "该用户名已被注册" });
  users[username] = { username: username, passwordHash: bcrypt.hashSync(password, 10) };
  saveUsers(users);
  const token = jwt.sign({ username: username }, SECRET, { expiresIn: "30d" });
  res.json({ token: token, username: username });
});

// 登录
app.post("/api/login", (req, res) => {
  const body = req.body || {};
  const username = (body.username || "").trim();
  const password = body.password || "";
  const users = loadUsers();
  const u = users[username];
  if (!u || !bcrypt.compareSync(password, u.passwordHash))
    return res.status(401).json({ error: "用户名或密码错误" });
  const token = jwt.sign({ username: username }, SECRET, { expiresIn: "30d" });
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
  res.json({ notes: list, serverTime: Date.now(), total: all.length });
});

// 同步（推送 + 合并 + 返回增量或完整集合，按 modifiedDate 后写覆盖）。
// 请求体可带 since：只返回该时刻之后入库的笔记，实现"近实时同步"的轻量轮询。
app.post("/api/notes/sync", auth, (req, res) => {
  const incoming = (req.body && req.body.notes) || [];
  const since = parseInt(req.body && req.body.since, 10) || 0;
  const store = loadNotes(req.user);
  var changed = false;
  incoming.forEach((n) => {
    if (!n || !n.id) return;
    const ex = store[n.id];
    if (!ex || (n.modifiedDate || 0) >= (ex.modifiedDate || 0)) {
      n.storedAt = Date.now(); // 服务端入库时间：增量游标以此为基准
      store[n.id] = n;
      changed = true;
    }
  });
  if (changed) saveNotes(req.user, store); // 没有实际变更则不重写文件（客户端每 3 秒轮询一次）
  var all = Object.keys(store).map((k) => store[k]);
  var list = since > 0 ? changedSince(all, since) : all;
  res.json({ notes: list, serverTime: Date.now(), total: all.length });
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
  console.error("服务器错误:", err && (err.stack || err.message));
  res.status(err.status || err.statusCode || 500).json({ error: "服务器内部错误" });
});

app.listen(PORT, HOST, () => {
  const inDocker = require("fs").existsSync("/.dockerenv");
  const ips = getLocalIps();
  console.log("简易笔记云同步服务已启动");
  console.log("本机访问：http://localhost:" + PORT);
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
