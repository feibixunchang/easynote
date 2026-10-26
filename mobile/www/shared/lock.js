/* ============ 简易笔记 · 密码解锁（单一来源）shared/lock.js ============
 * 4~6 位数字密码，锁屏覆盖层 + 设置入口，桌面（Electron）/ 移动（Capacitor）/ 网页版共用同一份。
 *
 * 定位要说清楚：这是一把"防止别人随手翻看"的锁（锁屏门禁），
 * **不加密本地数据** —— 懂技术的人拿到文件仍能读到笔记内容。
 * 想要真正的加密保护，需要另做"数据库加密 + 密码派生密钥"，不在本次范围内。
 *
 * 用法：
 *   EZLock.isEnabled()                    // 是否已设置密码
 *   EZLock.requireUnlock(onUnlocked)      // 启动时调用：已设密码 → 显示锁屏，解锁后回调；未设置 → 直接回调
 *   EZLock.lockNow()                      // 立即锁定（设置里点"立即锁定"）
 *   EZLock.setup({ onDone })              // 设置/修改密码（两次输入确认，用同一个键盘）
 *   EZLock.disable()                      // 关闭密码
 * ============================================================ */
(function (root) {
  "use strict";

  var KEY = "simplenote_zh_lock"; // { d: 摘要, n: 位数, t: 设置时间 }
  var MIN_LEN = 4;
  var MAX_LEN = 6;
  var FAIL_LIMIT = 5;             // 连续输错次数上限
  var LOCK_MS = 30 * 1000;        // 超限后锁定 30 秒（重启应用即重置）

  // 平台层访问器：统一从 root 取（浏览器里 root===window，但测试/嵌入式环境下两者可能不同）
  function plat() {
    try { return root.EZPlatform || null; } catch (e) { return null; }
  }

  function store() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function read() {
    var s = store();
    if (!s) return null;
    try {
      var r = JSON.parse(s.getItem(KEY));
      return (r && typeof r === "object" && r.d) ? r : null;
    } catch (e) { return null; }
  }
  function write(rec) {
    var s = store();
    if (!s) return;
    try { rec ? s.setItem(KEY, JSON.stringify(rec)) : s.removeItem(KEY); } catch (e) {}
  }

  // 摘要：只为了避免明文密码直接躺在 localStorage 里（非加密，够防"顺手一瞄"）
  function digest(pin) {
    var str = "easynote-lock:" + String(pin == null ? "" : pin);
    var h = 5381, i;
    for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) & 0xffffffff;
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }

  function isValidPin(pin) {
    var s = String(pin == null ? "" : pin);
    return new RegExp("^\\d{" + MIN_LEN + "," + MAX_LEN + "}$").test(s);
  }

  var api = {
    MIN_LEN: MIN_LEN,
    MAX_LEN: MAX_LEN,
    FAIL_LIMIT: FAIL_LIMIT,
    LOCK_MS: LOCK_MS,

    isValidPin: isValidPin,
    digest: digest,
    isEnabled: function () { return !!read(); },
    pinLength: function () { var r = read(); return r ? (r.n || MIN_LEN) : 0; },

    setPin: function (pin) {
      if (!isValidPin(pin)) return false;
      write({ d: digest(pin), n: String(pin).length, t: Date.now() });
      failCount = 0; lockedUntil = 0;
      return true;
    },
    clearPin: function () { write(null); failCount = 0; lockedUntil = 0; },
    verify: function (pin) {
      var r = read();
      return !!(r && r.d === digest(pin));
    },
    /* ---- 生物识别（刷脸 / 指纹）：只是"另一种解锁方式"，数字密码始终保留作兜底 ---- */
    isBiometricEnabled: function () { var r = read(); return !!(r && r.b === true); },
    biometricLabel: function () {
      try {
        return (plat() && plat().biometric && plat().biometric.label()) || "面容 / 指纹";
      } catch (e) { return "面容 / 指纹"; }
    },
    setBiometric: function (on) {
      var r = read();
      if (!r) return false; // 必须先有数字密码
      r.b = !!on;
      write(r);
      return true;
    },
    // 生物识别不可用时的原因（用于设置界面提示，如「未录入 Face ID」）
    biometricIssue: function () {
      var err = (plat() && plat().biometric && plat().biometric.lastError) ? plat().biometric.lastError() : null;
      if (!err) return "";
      var map = {
        biometryNotEnrolled: "系统里还没录入面容 / 指纹，请先到系统设置里录入",
        biometryNotAvailable: "此设备当前不可用面容 / 指纹（可能被其他应用占用或系统已锁定）",
        biometryLockout: "面容 / 指纹连续失败次数过多，已被系统临时锁定",
        userCancel: "你取消了生物识别",
        userFallback: "你选择了用密码，而不是面容 / 指纹",
        appCancel: "生物识别被系统取消（请稍后重试）",
        systemCancel: "生物识别被系统取消（请稍后重试）",
        passcodeNotSet: "设备没有设置锁屏密码，无法使用生物识别",
      };
      return map[err.code] || ("生物识别不可用：" + (err.message || err.code || "未知原因"));
    },

    // 设备是否支持（异步，与硬件/系统设置有关）
    areBiometricsSupported: function () {
      try {
        if (!plat() || !plat().biometric) return Promise.resolve(false);
        return Promise.resolve(plat().biometric.isAvailable()).catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    },
    // 打开生物识别：可用的前提下，浏览器还需要先"注册"一个本机凭证
    enableBiometric: function () {
      if (!api.isEnabled()) return Promise.resolve({ ok: false, error: "请先设置数字密码" });
      return api.areBiometricsSupported().then(function (ok) {
        if (!ok) {
          // 尽量给出"为什么不行"（未录入 / 被系统锁定 / 设备不支持），而不是笼统的"不支持"
          var why = api.biometricIssue();
          return { ok: false, error: why || "此设备不支持面容 / 指纹（或系统里尚未启用）" };
        }
        var enroll = (plat() && plat().biometric && plat().biometric.enroll)
          ? plat().biometric.enroll() : Promise.resolve(true);
        return Promise.resolve(enroll).then(function (cred) {
          if (cred === null) return { ok: false, error: "注册失败或已取消" };
          if (typeof cred === "string" && plat().biometric.saveCredential) plat().biometric.saveCredential(cred);
          api.setBiometric(true);
          return { ok: true };
        });
      }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
    },
    disableBiometric: function () {
      api.setBiometric(false);
      try {
        if (plat() && plat().biometric && plat().biometric.clearCredential) {
          plat().biometric.clearCredential();
        }
      } catch (e) {}
    },
    // 用生物识别解锁：成功 → 走与"密码正确"相同的成功路径；失败 → **不计入密码错误次数**
    tryBiometric: function (reason) {
      if (!api.isEnabled() || !api.isBiometricEnabled()) return Promise.resolve(false);
      var st = api.lockState();
      if (st.locked) return Promise.resolve(false);
      var verify = (plat() && plat().biometric && plat().biometric.verify)
        ? plat().biometric.verify(reason || "解锁简易笔记") : Promise.resolve(false);
      return Promise.resolve(verify).then(function (ok) {
        if (ok) { succeed(); return true; }
        // 把失败原因带上（如 biometryNotEnrolled / userCancel），便于用户判断是"没录入"还是"手势误触"
        var err = (plat() && plat().biometric && plat().biometric.lastError) ? plat().biometric.lastError() : null;
        var code = (err && err.code) ? "（" + err.code + "）" : "";
        setMsg("生物识别未通过" + code + "，请用数字密码解锁");
        return false;
      }).catch(function () { return false; });
    },

    // 输错/锁定状态（纯函数式读取，便于测试）
    lockState: function (now) {
      now = now || Date.now();
      var left = lockedUntil - now;
      return {
        fails: failCount,
        locked: left > 0,
        waitSec: left > 0 ? Math.ceil(left / 1000) : 0,
      };
    },
    registerFail: function (now) {
      now = now || Date.now();
      failCount++;
      if (failCount >= FAIL_LIMIT) { lockedUntil = now + LOCK_MS; failCount = 0; }
      return api.lockState(now);
    },
  };

  var failCount = 0;
  var lockedUntil = 0;

  /* ---------------- 锁屏 UI（自带样式与 DOM，三端一致）---------------- */
  var el = null;
  var mode = "unlock";     // unlock | setup-new | setup-confirm
  var input = "";
  var pendingNew = "";
  var onUnlockedCb = null;
  var onDoneCb = null;
  var tickTimer = null;
  var autoBioTimer = null;

  function injectStyle() {
    if (root.document.getElementById("ezlock-style")) return;
    var css = [
      "#ezlock{position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;",
      "background:#f7f7f7;color:#333;font-family:-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;-webkit-user-select:none;user-select:none}",
      "#ezlock.dark{background:#252525;color:#eee}",
      "#ezlock .lk-title{font-size:16px;font-weight:600;margin-bottom:6px}",
      "#ezlock .lk-sub{font-size:12px;opacity:.6;margin-bottom:22px;text-align:center;line-height:1.6;max-width:280px}",
      "#ezlock .lk-dots{display:flex;gap:12px;margin-bottom:10px}",
      "#ezlock .lk-dot{width:14px;height:14px;border-radius:50%;border:1.5px solid #4189e6;box-sizing:border-box}",
      "#ezlock .lk-dot.on{background:#4189e6}",
      "#ezlock .lk-msg{height:18px;font-size:12px;color:#d9534f;margin:6px 0 14px}",
      "#ezlock .lk-pad{display:grid;grid-template-columns:repeat(3,72px);gap:14px;justify-content:center}",
      "#ezlock .lk-key{height:64px;border-radius:12px;border:1px solid rgba(0,0,0,.12);background:#fff;font-size:22px;color:inherit;",
      "display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent}",
      "#ezlock.dark .lk-key{background:#3a3a3a;border-color:rgba(255,255,255,.14)}",
      "#ezlock .lk-key:active{background:#eaf2fd}",
      "#ezlock.dark .lk-key:active{background:#454545}",
      "#ezlock .lk-key.fn{font-size:13px;color:#4189e6;background:transparent;border-color:transparent}",
      "#ezlock .lk-shake{animation:ezlock-shake .3s}",
      "@keyframes ezlock-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}",
      "#ezlock .lk-forgot{margin-top:18px;font-size:12px;color:#4189e6;cursor:pointer;text-decoration:underline}",
      "#ezlock .lk-bio{margin:0 0 14px;padding:9px 16px;border-radius:20px;border:1px solid #4189e6;background:transparent;",
      "color:#4189e6;font-size:13px;cursor:pointer;-webkit-tap-highlight-color:transparent}",
    ].join("");
    var st = root.document.createElement("style");
    st.id = "ezlock-style";
    st.textContent = css;
    root.document.head.appendChild(st);
  }

  function build() {
    if (el) return el;
    injectStyle();
    var wrap = root.document.createElement("div");
    wrap.id = "ezlock";
    wrap.innerHTML =
      '<div class="lk-title" id="lkTitle">输入密码解锁</div>' +
      '<div class="lk-sub" id="lkSub">4~6 位数字密码 · 仅本机校验，不加密数据</div>' +
      '<div class="lk-dots" id="lkDots"></div>' +
      '<div class="lk-msg" id="lkMsg"></div>' +
      '<button type="button" class="lk-bio" id="lkBio" hidden></button>' +
      '<div class="lk-pad" id="lkPad"></div>' +
      '<div class="lk-forgot" id="lkForgot">忘记密码？</div>';
    root.document.body.appendChild(wrap);

    var pad = wrap.querySelector("#lkPad");
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "fn-del", "0", "fn-ok"];
    keys.forEach(function (k) {
      var b = root.document.createElement("button");
      b.type = "button";
      b.className = "lk-key" + (k.indexOf("fn-") === 0 ? " fn" : "");
      b.textContent = k === "fn-del" ? "删除" : (k === "fn-ok" ? "确定" : k);
      b.addEventListener("click", function () { onKey(k); });
      pad.appendChild(b);
    });
    wrap.querySelector("#lkForgot").addEventListener("click", forgot);
    wrap.querySelector("#lkBio").addEventListener("click", function () {
      api.tryBiometric().catch(function () {});
    });
    el = {
      wrap: wrap,
      title: wrap.querySelector("#lkTitle"),
      sub: wrap.querySelector("#lkSub"),
      dots: wrap.querySelector("#lkDots"),
      msg: wrap.querySelector("#lkMsg"),
      forgot: wrap.querySelector("#lkForgot"),
      bio: wrap.querySelector("#lkBio"),
    };
    return el;
  }

  function renderDots() {
    var len = mode === "unlock" ? (api.pinLength() || MIN_LEN) : Math.max(MIN_LEN, Math.min(MAX_LEN, input.length || MIN_LEN));
    var html = "";
    for (var i = 0; i < len; i++) html += '<div class="lk-dot' + (i < input.length ? " on" : "") + '"></div>';
    el.dots.innerHTML = html;
  }

  function setMsg(text, red) {
    el.msg.textContent = text || "";
    el.msg.style.color = red === false ? "#4189e6" : "#d9534f";
  }

  function clearTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function startCountdown() {
    clearTick();
    var update = function () {
      var st = api.lockState();
      if (!st.locked) {
        clearTick();
        setMsg("");
        return;
      }
      setMsg("输错次数过多，请 " + st.waitSec + " 秒后再试");
    };
    update();
    tickTimer = setInterval(update, 500);
  }

  function shake() {
    el.dots.classList.add("lk-shake");
    setTimeout(function () { el.dots.classList.remove("lk-shake"); }, 320);
  }

  function show() {
    build();
    var autoBio = (mode === "unlock") && api.isBiometricEnabled();
    var dark = false;
    try {
      dark = /(^|\s)dark(\s|$)/.test(root.document.body.className) ||
        /(^|\s)dark(\s|$)/.test(root.document.documentElement.className);
    } catch (e) {}
    el.wrap.className = dark ? "dark" : "";
    el.wrap.style.display = "flex";
    renderDots();
    setMsg("");
    startCountdown();
    if (autoBio) {
      // 稍等一下再弹，避免刚切到锁屏就打断用户的手势；
      // 首次失败常见于"应用刚启动、系统还没准备好"，1.2 秒后静默重试一次。
      clearTimeout(autoBioTimer);
      autoBioTimer = setTimeout(function () {
        api.tryBiometric().then(function (ok) {
          if (ok) return;
          autoBioTimer = setTimeout(function () { api.tryBiometric().catch(function () {}); }, 1200);
        }).catch(function () {});
      }, 900);
    }
  }
  function hide() {
    clearTimeout(autoBioTimer);
    clearTick();
    if (el) el.wrap.style.display = "none";
  }

  // keepPending=true 用于"设置 → 再次确认"的切换：必须保留第一次输入的密码，
  // 否则确认步拿空串去比较，会永远报"两次输入不一致"（1.2.33 的 bug）。
  function resetFor(m, keepPending) {
    mode = m;
    input = "";
    if (!keepPending) pendingNew = "";
    build();
    if (m === "unlock") {
      el.title.textContent = "输入密码解锁";
      el.sub.textContent = api.MIN_LEN + "~" + api.MAX_LEN + " 位数字密码 · 仅本机校验，不加密数据";
      el.forgot.style.display = "block";
      // 生物识别：已开启才显示按钮，并在进入锁屏时自动弹一次（失败不影响密码尝试）
      var bioOn = api.isBiometricEnabled();
      el.bio.hidden = !bioOn;
      if (bioOn) {
        var lb = api.biometricLabel();
        el.bio.textContent = "👆 用 " + lb + " 解锁";
      }
    } else if (m === "setup-new") {
      el.title.textContent = "设置密码";
      el.sub.textContent = "请输入 " + api.MIN_LEN + "~" + api.MAX_LEN + " 位数字";
      el.forgot.style.display = "none";
    } else {
      el.title.textContent = "再次输入确认";
      el.sub.textContent = "请再输入一遍刚才的密码";
      el.forgot.style.display = "none";
    }
    setMsg("");
    renderDots();
  }

  function onKey(k) {
    var st = api.lockState();
    if (st.locked) { shake(); setMsg("输错次数过多，请 " + st.waitSec + " 秒后再试"); return; }
    if (k === "fn-del") {
      input = input.slice(0, -1);
      renderDots();
      return;
    }
    if (k === "fn-ok") { submit(); return; }
    if (input.length >= MAX_LEN) return;
    input += k;
    renderDots();
    // 够到"已知位数"就自动校验（解锁模式）
    if (mode === "unlock") {
      var want = api.pinLength();
      if (want && input.length === want) setTimeout(submit, 80);
    } else if (mode === "setup-new" && input.length >= MIN_LEN) {
      // 设置模式：到 6 位自动进入确认，或不按确定也行
      if (input.length === MAX_LEN) setTimeout(submit, 80);
    }
  }

  function submit() {
    if (mode === "unlock") {
      if (api.verify(input)) { succeed(); return; }
      var st = api.registerFail();
      input = "";
      renderDots();
      shake();
      if (st.locked) startCountdown();
      else setMsg("密码不正确，还可尝试 " + (api.FAIL_LIMIT - st.fails) + " 次");
      return;
    }
    if (mode === "setup-new") {
      if (!isValidPin(input)) { shake(); setMsg("请输入 " + MIN_LEN + "~" + MAX_LEN + " 位数字"); return; }
      pendingNew = input;
      resetFor("setup-confirm", true);   // 保留第一次输入
      return;
    }
    // setup-confirm
    if (input !== pendingNew) {
      input = ""; pendingNew = "";
      resetFor("setup-new");
      setMsg("两次输入不一致，请重新设置");
      return;
    }
    api.setPin(input);
    hide();
    var done = onDoneCb;
    onDoneCb = null;
    if (done) done(true);
  }

  // 解锁成功（数字密码或生物识别共用）：清掉失败计数并回调
  function succeed() {
    failCount = 0;
    lockedUntil = 0;
    input = "";
    hide();
    var cb = onUnlockedCb;
    onUnlockedCb = null;
    if (cb) cb();
  }

  function forgot() {
    if (mode !== "unlock") return;
    if (!root.confirm("忘记密码？\n\n这是一把「防止别人随手翻看」的锁，不加密数据。\n清除密码后笔记仍完整保留，但锁屏将解除。\n\n确定清除密码并进入吗？")) return;
    api.clearPin();
    hide();
    var cb = onUnlockedCb;
    onUnlockedCb = null;
    if (cb) cb();
  }

  api.requireUnlock = function (onUnlocked) {
    if (!api.isEnabled()) { onUnlocked(); return; }
    onUnlockedCb = onUnlocked;
    resetFor("unlock");
    show();
  };
  api.lockNow = function () {
    if (!api.isEnabled()) return;
    resetFor("unlock");
    show();
  };
  api.setup = function (opts) {
    opts = opts || {};
    onDoneCb = opts.onDone || null;
    failCount = 0; lockedUntil = 0;
    resetFor("setup-new");
    show();
  };
  api.disable = function () { api.clearPin(); };

  /* 测试钩子：仅供 tools/test-lock.js 驱动状态机（不进界面逻辑） */
  api._test = {
    key: function (k) { onKey(k); },
    state: function () { return { mode: mode, input: input, pending: pendingNew }; },
  };

  root.EZLock = api;
})(typeof window !== "undefined" ? window : this);
