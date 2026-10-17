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
  try { return JSON.parse(fs.readFileSync(userNotesFile(u), "utf8")); } catch (e) { return {}; }
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
app.use(cors());
app.use(express.json());

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

// 拉取全部笔记
app.get("/api/notes", auth, (req, res) => {
  const notes = loadNotes(req.user);
  res.json({ notes: Object.keys(notes).map((k) => notes[k]) });
});

// 同步（推送 + 合并 + 返回完整集合，按 modifiedDate 后写覆盖）
app.post("/api/notes/sync", auth, (req, res) => {
  const incoming = (req.body && req.body.notes) || [];
  const store = loadNotes(req.user);
  incoming.forEach((n) => {
    if (!n || !n.id) return;
    const ex = store[n.id];
    if (!ex || (n.modifiedDate || 0) >= (ex.modifiedDate || 0)) store[n.id] = n;
  });
  saveNotes(req.user, store);
  res.json({ notes: Object.keys(store).map((k) => store[k]) });
});

app.listen(PORT, HOST, () => {
  const ips = getLocalIps();
  console.log("简易笔记云同步服务已启动");
  console.log("本机访问：http://localhost:" + PORT);
  if (ips.length) {
    console.log("其他设备请用下面的「局域网地址」登录：");
    ips.forEach(function (ip) {
      console.log("   http://" + ip + ":" + PORT + "    （" + ipLabel(ip) + "）");
    });
  }
  console.log("监听地址：" + HOST + ":" + PORT + "（0.0.0.0 表示所有网卡，局域网均可访问）");
});

// 常见局域网网段优先，VPN/虚拟网卡地址排在后面
function getLocalIps() {
  const nets = require("os").networkInterfaces();
  const lan = [];
  const other = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if ((net.family === "IPv4" || net.family === 4) && !net.internal) {
        if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(net.address)) lan.push(net.address);
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
