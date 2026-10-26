#!/usr/bin/env node
/* ============================================================
 * 同步服务端回归测试（server.js）
 * ------------------------------------------------------------
 * 覆盖本次数据安全加固的 5 个关键点，防止以后改动把这几个坑重新踩回去：
 *   1) 墓碑保护：已永久删除的笔记不会被其他设备的旧副本"复活"
 *   2) 删除后的新修改仍可正常复活（真正的撤销删除）
 *   3) 增量游标：不重复返回、不遗漏（单调入库时间戳）
 *   4) 原子写 + .bak 备份（抗"写一半被截断"）
 *   5) 脏数据拦截：非法用户名 / 非法笔记 id（含 __proto__ 原型污染）
 *
 * 用法：node server/test-sync.js
 * 说明：会在系统临时目录建一个独立的 DATA_DIR，不碰任何真实数据；
 *       端口默认 3999，可用环境变量 TEST_PORT 覆盖。
 * ============================================================ */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_DIR = __dirname;
const PORT = parseInt(process.env.TEST_PORT || "3999", 10);
const BASE = "http://127.0.0.1:" + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easynote-test-"));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" },
      token ? { Authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}

(async () => {
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: DATA_DIR,
      JWT_SECRET: "test-secret-0123456789abcdef",
      ALLOW_REGISTRATION: "true",
      LOGIN_MAX_FAILS: "999",
      BCRYPT_ROUNDS: "4", // 测试用低成本因子，加快速度
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += String(d); });

  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const h = await api("GET", "/api/health"); if (h.json && h.json.ok) { up = true; break; } } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    console.error("服务未能在预期时间内启动。stderr:\n" + stderr);
    proc.kill("SIGKILL");
    process.exit(1);
  }

  try {
    console.log("\n【1】注册与鉴权");
    const reg = await api("POST", "/api/register", { username: "u1", password: "password123" });
    ok("注册成功并返回 token", reg.status === 200 && !!reg.json.token, JSON.stringify(reg.json));
    const token = reg.json.token;

    console.log("\n【2】同步 + 游标不重复");
    const t0 = Date.now();
    const s1 = await api("POST", "/api/notes/sync", { notes: [{ id: "n_a1", content: "v1", modifiedDate: t0 }], since: 0 }, token);
    ok("首次同步拿到 1 条", s1.json.notes.length === 1, String(s1.json.notes.length));
    const stamp = s1.json.notes[0].storedAt;
    ok("响应 serverTime >= 入库时间", typeof s1.json.serverTime === "number" && s1.json.serverTime >= stamp);
    const s2 = await api("POST", "/api/notes/sync", { notes: [], since: s1.json.serverTime }, token);
    ok("带游标再同步不重复返回", s2.json.notes.length === 0, String(s2.json.notes.length));

    console.log("\n【3】墓碑保护：已删除的笔记不能被旧副本复活");
    await api("POST", "/api/notes/purge", { ids: ["n_a1"] }, token);
    const stale = await api("POST", "/api/notes/sync", {
      notes: [{ id: "n_a1", content: "stale-copy-from-device-B", modifiedDate: t0 }], since: 0,
    }, token);
    ok("旧副本被拒绝（不写入）", !stale.json.notes.some((n) => n.id === "n_a1"));
    ok("被拒 id 回传到 removed", (stale.json.removed || []).indexOf("n_a1") !== -1, JSON.stringify(stale.json.removed));
    const full = await api("GET", "/api/notes?since=0", null, token);
    ok("全量拉取确认未被复活", !full.json.notes.some((n) => n.id === "n_a1"));

    console.log("\n【4】真正的撤销删除仍可复活");
    const revive = await api("POST", "/api/notes/sync", {
      notes: [{ id: "n_a1", content: "revived-on-purpose", modifiedDate: Date.now() + 60000 }], since: 0,
    }, token);
    ok("修改时间晚于删除时间 → 可复活", revive.json.notes.some((n) => n.id === "n_a1" && n.content === "revived-on-purpose"));

    console.log("\n【5】脏数据拦截");
    ok("用户名含 ../ 被拒", (await api("POST", "/api/register", { username: "../evil", password: "password123" })).status === 400);
    ok("用户名 __proto__ 被拒", (await api("POST", "/api/register", { username: "__proto__", password: "password123" })).status === 400);
    const badId = await api("POST", "/api/notes/sync", { notes: [{ id: "__proto__", content: "x", modifiedDate: Date.now() }], since: 0 }, token);
    ok("笔记 id __proto__ 被忽略", (badId.json.notes || []).every((n) => n.id !== "__proto__"));
    const badPurge = await api("POST", "/api/notes/purge", { ids: ["../../../etc/hosts"] }, token);
    ok("purge 非法 id 不生效且不报错", badPurge.status === 200 && (badPurge.json.removed || []).length === 0, JSON.stringify(badPurge.json));

    console.log("\n【6】原子写 + 备份");
    const notesFile = path.join(DATA_DIR, "notes", "u1.json");
    ok("笔记文件已生成", fs.existsSync(notesFile));
    ok("存在 .bak 备份", fs.existsSync(notesFile + ".bak"));
    ok("没有遗留 .tmp", fs.readdirSync(path.join(DATA_DIR, "notes")).filter((f) => f.endsWith(".tmp")).length === 0);

    console.log("\n【7】单调时间戳（同毫秒写入不自相覆盖、不漏）");
    const many = [];
    for (let i = 0; i < 30; i++) many.push({ id: "n_b" + i, content: "c" + i, modifiedDate: t0 + 1 });
    const r7 = await api("POST", "/api/notes/sync", { notes: many, since: 0 }, token);
    const stamps = r7.json.notes.map((n) => n.storedAt);
    ok("30 条同事写入时间戳互不相同", new Set(stamps).size === stamps.length);
    ok("游标大于所有入库时间戳", r7.json.serverTime >= Math.max.apply(null, stamps));
  } catch (e) {
    fail++;
    console.error("测试异常: " + (e && e.stack || e));
  }

  proc.kill("SIGKILL");
  console.log("\n────────────────────────");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项   (临时数据目录: " + DATA_DIR + ")");
  process.exit(fail ? 1 : 0);
})();
