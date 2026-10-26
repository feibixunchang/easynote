#!/usr/bin/env node
/* ============================================================
 * 密码解锁单元测试（shared/lock.js）
 * ------------------------------------------------------------
 * 这是"锁屏门禁"，逻辑一旦出错就会出现：密码永远输不对（把用户锁在外面）、
 * 或者输错也不拦（锁形同虚设）。所以把纯逻辑与存储行为都锁住。
 *
 * 用法：node tools/test-lock.js
 * ============================================================ */
"use strict";

const path = require("path");
const LOCK = path.join(__dirname, "..", "shared", "lock.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function loadWith(fakeStorage) {
  delete require.cache[require.resolve(LOCK)];
  const win = {
    localStorage: fakeStorage,
    confirm: () => true,
    document: { head: { appendChild() {} }, body: { appendChild() {}, className: "" }, documentElement: { className: "" },
                createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, appendChild(){}, addEventListener(){},
                                        querySelector: () => null, setAttribute(){}, textContent: "" }),
                getElementById: () => null },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
  };
  global.window = win;
  require(LOCK);
  return global.window.EZLock;
}
function memStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _raw: m,
  };
}

const st = memStorage();
const EZ = loadWith(st);

console.log("\n【1】密码格式校验（4~6 位数字）");
ok("4 位通过", EZ.isValidPin("1234") === true);
ok("6 位通过", EZ.isValidPin("123456") === true);
ok("3 位拒绝", EZ.isValidPin("123") === false);
ok("7 位拒绝", EZ.isValidPin("1234567") === false);
ok("含字母拒绝", EZ.isValidPin("12a4") === false);
ok("空值拒绝", EZ.isValidPin("") === false);

console.log("\n【2】摘要：稳定且不出现明文");
ok("同一密码摘要稳定", EZ.digest("1234") === EZ.digest("1234"));
ok("不同密码摘要不同", EZ.digest("1234") !== EZ.digest("1235"));
ok("摘要不含明文密码", EZ.digest("1234").indexOf("1234") === -1);

console.log("\n【3】设置 / 校验 / 关闭");
ok("初始未开启", EZ.isEnabled() === false);
ok("设置 4 位成功", EZ.setPin("1234") === true);
ok("设置后为已开启", EZ.isEnabled() === true);
ok("记录了密码位数（用于自动提交）", EZ.pinLength() === 4, String(EZ.pinLength()));
ok("正确密码通过", EZ.verify("1234") === true);
ok("错误密码不通过", EZ.verify("9999") === false);
ok("拒绝设置非法密码", EZ.setPin("12") === false);
ok("非法设置不会破坏原有密码", EZ.verify("1234") === true);
ok("localStorage 里没有明文", JSON.stringify(st._raw).indexOf('"1234"') === -1, JSON.stringify(st._raw));
EZ.setPin("123456");
ok("改密码后位数更新", EZ.pinLength() === 6);
ok("新密码生效", EZ.verify("123456") === true && EZ.verify("1234") === false);
EZ.clearPin();
ok("关闭后不再启用", EZ.isEnabled() === false);

console.log("\n【4】连续输错 → 锁定（防暴力试）");
const st2 = memStorage();
const EZ2 = loadWith(st2);
EZ2.setPin("1234");
let t = 1000000;
let state = EZ2.lockState(t);
ok("初始未锁定", state.locked === false && state.fails === 0);
for (let i = 0; i < EZ2.FAIL_LIMIT - 1; i++) state = EZ2.registerFail(t);
ok("未到上限时不锁定，但记录失败次数", state.locked === false && state.fails === EZ2.FAIL_LIMIT - 1, JSON.stringify(state));
state = EZ2.registerFail(t);
ok("达到上限 → 锁定", state.locked === true && state.waitSec === Math.ceil(EZ2.LOCK_MS / 1000), JSON.stringify(state));
state = EZ2.lockState(t + EZ2.LOCK_MS / 2);
ok("锁定期间剩余时间递减", state.locked === true && state.waitSec === Math.ceil(EZ2.LOCK_MS / 2000), JSON.stringify(state));
state = EZ2.lockState(t + EZ2.LOCK_MS + 1);
ok("锁定到期自动解除", state.locked === false, JSON.stringify(state));
ok("正确密码仍然有效（锁定期不影响校验本身）", EZ2.verify("1234") === true);

console.log("\n────────────────────────");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
