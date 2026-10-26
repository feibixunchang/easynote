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
    document: (() => {
      // 极简 DOM 桩：够 build()/renderDots() 跑通（用 EZLock._test 驱动状态机做流程测试）
      const node = () => {
        const n = {
          style: {}, className: "", textContent: "", innerHTML: "", type: "", id: "",
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          _kids: [],
          appendChild(c) { this._kids.push(c); return c; },
          removeChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
          querySelector() { return node(); },
          _handlers: {},
        };
        return n;
      };
      return {
        head: node(), body: node(), documentElement: node(),
        createElement: () => node(),
        getElementById: () => null,
        execCommand: () => true,
      };
    })(),
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

console.log("\n【5】设置密码两步流程（回归：1.2.33 曾恒报「两次输入不一致」）");
{
  const st3 = memStorage();
  const EZ3 = loadWith(st3);
  let doneOk = null;
  EZ3.setup({ onDone: function (ok) { doneOk = ok; } });
  ["1", "2", "3", "4"].forEach((k) => EZ3._test.key(k));
  EZ3._test.key("fn-ok");
  const s1 = EZ3._test.state();
  ok("第一步输入被保留下来（修复点）", s1.mode === "setup-confirm" && s1.pending === "1234", JSON.stringify(s1));
  ["1", "2", "3", "4"].forEach((k) => EZ3._test.key(k));
  EZ3._test.key("fn-ok");
  ok("两次一致 → 保存成功并回调 onDone(true)", doneOk === true, String(doneOk));
  ok("密码已生效", EZ3.isEnabled() === true && EZ3.verify("1234") === true);

  // 反例：两次不一致 → 回到第一步并提示，且不应保存
  let doneOk2 = null;
  EZ3.setup({ onDone: function (ok) { doneOk2 = ok; } });
  ["9", "9", "9", "9"].forEach((k) => EZ3._test.key(k));
  EZ3._test.key("fn-ok");
  ["8", "8", "8", "8"].forEach((k) => EZ3._test.key(k));
  EZ3._test.key("fn-ok");
  const s2 = EZ3._test.state();
  ok("两次不一致 → 回到第一步、不回调成功", s2.mode === "setup-new" && doneOk2 === null, JSON.stringify(s2));
  ok("原有密码未被破坏", EZ3.verify("1234") === true);

  // 6 位也走通（够位自动进入确认）
  let doneOk3 = null;
  EZ3.setup({ onDone: function (ok) { doneOk3 = ok; } });
  ["1", "2", "3", "4", "5", "6"].forEach((k) => EZ3._test.key(k));
  // 6 位会自动 submit（setTimeout 80ms）→ 稍后再输确认
  setTimeout(function () {
    ["1", "2", "3", "4", "5", "6"].forEach((k) => EZ3._test.key(k));
    EZ3._test.key("fn-ok");
    ok("6 位密码两次一致也能保存", doneOk3 === true && EZ3.verify("123456") === true, String(doneOk3));
    (async function () {

console.log("\n【6】生物识别（面容 / 指纹）");
{
  const st = memStorage();
  let bioOk = false, enrollCalled = 0, credSaved = null;
  const win = {
    localStorage: st,
    confirm: () => true,
    EZPlatform: {
      biometric: {
        label: () => "面容 / 指纹",
        isAvailable: () => Promise.resolve(true),
        enroll: () => { enrollCalled++; return Promise.resolve("cred-id-1"); },
        saveCredential: (id) => { credSaved = id; },
        clearCredential: () => { credSaved = null; },
        verify: () => Promise.resolve(bioOk),
      },
    },
    // 复用与 loadWith 相同的极简 DOM 桩（保证 build()/renderDots() 能跑通）
    document: (() => {
      const node = () => ({
        style: {}, className: "", textContent: "", innerHTML: "", type: "", id: "",
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild(c) { return c; }, removeChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
        querySelector: () => node(), hidden: false,
      });
      return { head: node(), body: node(), documentElement: node(), createElement: () => node(), getElementById: () => null, execCommand: () => true };
    })(),
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
  };
  delete require.cache[require.resolve(LOCK)];
  global.window = win;
  require(LOCK);
  const EZ = global.window.EZLock;

  ok("未设密码时不能开生物识别", EZ.isBiometricEnabled() === false);
  ok("没有密码时 enableBiometric 被拒", (await EZ.enableBiometric()).ok === false);

  EZ.setPin("1234");
  const en = await EZ.enableBiometric();
  ok("开启生物识别：走了注册流程并保存凭证", en.ok === true && enrollCalled === 1 && credSaved === "cred-id-1", JSON.stringify(en));
  ok("开启后状态为已启用", EZ.isBiometricEnabled() === true);
  ok("重启（重新加载）后仍记得已启用", (function () {
    delete require.cache[require.resolve(LOCK)];
    require(LOCK);
    return global.window.EZLock.isBiometricEnabled() === true;
  })());
  ok("标签来自平台层", global.window.EZLock.biometricLabel() === "面容 / 指纹");

  // 识别失败：不计入"密码输错次数"（不能因为刷脸失败而锁定用户）
  const EZ2 = global.window.EZLock;
  bioOk = false;
  const bad = await EZ2.tryBiometric();
  const stAfterFail = EZ2.lockState();
  ok("识别失败返回 false", bad === false);
  ok("识别失败不计入密码错误次数", stAfterFail.fails === 0 && stAfterFail.locked === false, JSON.stringify(stAfterFail));

  // 识别成功：应直接解锁（触发 requireUnlock 的回调）
  let unlocked = false;
  EZ2.requireUnlock(function () { unlocked = true; });   // 已启用密码 → 注册回调
  bioOk = true;
  const good = await EZ2.tryBiometric();
  ok("识别成功返回 true", good === true);
  ok("识别成功后回调被触发（进入应用）", unlocked === true);

  // 关闭生物识别 → 清掉浏览器凭证
  EZ2.disableBiometric();
  ok("关闭后状态为未启用", EZ2.isBiometricEnabled() === false);
  ok("关闭时清掉了本机凭证", credSaved === null);
  ok("数字密码依然有效（兜底始终保留）", EZ2.verify("1234") === true);
}


      console.log("\n────────────────────────");
      console.log("通过 " + pass + " 项，失败 " + fail + " 项");
      process.exit(fail ? 1 : 0);
    })();
  }, 200);
}
