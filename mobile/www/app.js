/* ============ 简易笔记 · 移动端核心逻辑 ============
 * 与桌面端（app.js）同一套数据模型与同步协议，UI 为手机/平板自适应：
 *   - 单栏（<720px）：列表 / 编辑器 / 设置 三屏 + 底部导航 + FAB
 *   - 双栏（≥720px）：列表 + 编辑器 并排，界面随屏幕大小自适应
 * 平台能力：Capacitor（相机/相册、分享、文件、浏览器、状态栏、返回键）；
 * 纯浏览器预览时自动退化为 Web API。
 */
(function () {
  "use strict";

  /* ---- 共享核心 shared/core.js（纯函数单一来源，三端一致）----
   * 这些工具函数不再各自复制一份，改一处即三端生效；
   * tools/parity-check.sh 会在 CI 里校验三端引用是否齐全。 */
  if (typeof EZCore === "undefined" || !EZCore) {
    throw new Error("缺少共享核心 shared/core.js（各端 index.html 需在 app.js 之前引入它）");
  }
  var isValidNoteId = EZCore.isValidNoteId;
  var escapeHtml = EZCore.escapeHtml;
  var escapeAttr = EZCore.escapeAttr;
  var inlineMd = EZCore.inlineMd;
  var renderMarkdown = EZCore.renderMarkdown;

  /* ---------------- 存储键（与桌面端一致，同账号跨端互通） ---------------- */
  var STORE_KEY = "simplenote_zh_v1";
  var DARK_KEY = "simplenote_zh_dark";
  var THEME_KEY = "simplenote_zh_theme"; // auto | light | dark
  var FONT_KEY = "simplenote_zh_font";
  var FONTSIZE_KEY = "simplenote_zh_fontsize";
  var SERVER_KEY = "simplenote_zh_server";
  var TOKEN_KEY = "simplenote_zh_token";
  var USER_KEY = "simplenote_zh_user";
  var PURGE_KEY = "simplenote_zh_purged";
  var SINCE_KEY = "simplenote_zh_since";
  var PUSHED_KEY = "simplenote_zh_pushed";
  var TOTAL_KEY = "simplenote_zh_total";
  var DAV_KEY = "simplenote_zh_webdav";
  var TRASHDAYS_KEY = "simplenote_zh_trashdays"; // 回收站自动清理天数（0 = 关闭）
  // 兜底版本号：原生端由 App.getInfo() 覆盖；浏览器/预览环境下用它
  var APP_VERSION = "1.0.15";

  // 安全存储：隐私模式 / 存储被禁时回退内存，保证可用
  var _mem = {};
  var store = (function () {
    function ls() {
      try { return localStorage; } catch (e) { return null; }
    }
    return {
      getItem: function (k) {
        var s = ls();
        return s ? s.getItem(k) : (k in _mem ? _mem[k] : null);
      },
      setItem: function (k, v) {
        var s = ls();
        if (s) { try { s.setItem(k, v); return; } catch (e) {} }
        _mem[k] = String(v);
      },
      removeItem: function (k) {
        var s = ls();
        if (s) { try { s.removeItem(k); return; } catch (e) {} }
        delete _mem[k];
      },
    };
  })();

  /* ---------------- 平台能力 ---------------- */
  // 惰性读取 window.Capacitor：原生桥接脚本注入时机在不同平台/版本下不完全一致，
  // 若在脚本解析时就缓存 var Cap = window.Capacitor，可能拿到 null 导致
  // 后续所有原生能力（状态栏、相机、CapacitorHttp…）静默失效。
  function cap() {
    return window.Capacitor || window.Cap || null;
  }
  function plugin(name) {
    try {
      var c = cap();
      if (!c) return null;
      if (c.Plugins && c.Plugins[name]) return c.Plugins[name];
      // 部分版本直接挂在 Cap 上（如 Cap.CapacitorHttp）
      return c[name] || null;
    } catch (e) { return null; }
  }
  function isNative() {
    try {
      var c = cap();
      return !!(c && c.isNativePlatform && c.isNativePlatform());
    } catch (e) { return false; }
  }
  function utf8ToBase64(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }
  function base64ToUtf8(b) {
    return decodeURIComponent(escape(atob(b)));
  }

  /* ---------------- 颜色调色板（与桌面端一致） ---------------- */
  var COLOR_PALETTE = [
    { key: "", name: "无颜色" },
    { key: "red", name: "红色", color: "#e05252" },
    { key: "orange", name: "橙色", color: "#e08a3c" },
    { key: "yellow", name: "黄色", color: "#d9b23c" },
    { key: "green", name: "绿色", color: "#4caf7d" },
    { key: "cyan", name: "青色", color: "#3aa8b5" },
    { key: "blue", name: "蓝色", color: "#4a80d9" },
    { key: "purple", name: "紫色", color: "#8a6fd6" },
    { key: "pink", name: "粉色", color: "#d96a9b" },
  ];
  function colorOf(key) {
    for (var i = 0; i < COLOR_PALETTE.length; i++) {
      if (COLOR_PALETTE[i].key === key) return COLOR_PALETTE[i];
    }
    return COLOR_PALETTE[0];
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    notes: [],
    currentId: null,
    query: "",
    activeTag: null,
    view: "notes", // 'notes' | 'trash'
    trashAutoDays: 0, // 回收站自动清理天数（0 = 关闭）
    selected: {}, // 回收站里勾选的笔记 id（批量恢复 / 批量删除）
    sort: "modified",
    themeMode: "auto",
    systemDark: false,
    dark: false,
    preview: false,
    fontFamily: "",
    fontSize: 16,
    token: "",
    user: "",
    serverUrl: "http://localhost:3000",
    lastSyncTs: 0,
    purged: [],
    since: 0,
    pushed: {},
    serverTotal: 0,
    legacyServer: false,
    dav: { server: "", username: "", password: "", dir: "/easynote" },
  };

  /* ---------------- 存储 / 主题 ---------------- */
  function load() {
    try {
      state.notes = JSON.parse(store.getItem(STORE_KEY)) || [];
    } catch (e) {
      state.notes = [];
    }
    var mode = store.getItem(THEME_KEY);
    if (mode === "auto" || mode === "light" || mode === "dark") {
      state.themeMode = mode;
    } else if (store.getItem(DARK_KEY) === "1") {
      state.themeMode = "dark";
    } else if (store.getItem(DARK_KEY) === "0") {
      state.themeMode = "light";
    } else {
      state.themeMode = "auto";
    }
    state.fontFamily = store.getItem(FONT_KEY) || "";
    state.fontSize = parseInt(store.getItem(FONTSIZE_KEY) || "16", 10) || 16;
    // 回收站自动清理：默认关闭（自动删数据必须用户明确选择）
    state.trashAutoDays = parseInt(store.getItem(TRASHDAYS_KEY) || "0", 10) || 0;
    state.serverUrl = store.getItem(SERVER_KEY) || "http://localhost:3000";
    state.token = store.getItem(TOKEN_KEY) || "";
    state.user = store.getItem(USER_KEY) || "";
    try {
      state.purged = JSON.parse(store.getItem(PURGE_KEY)) || [];
      if (!Array.isArray(state.purged)) state.purged = [];
    } catch (e) {
      state.purged = [];
    }
    state.since = parseInt(store.getItem(SINCE_KEY) || "0", 10) || 0;
    state.serverTotal = parseInt(store.getItem(TOTAL_KEY) || "0", 10) || 0;
    try {
      state.pushed = JSON.parse(store.getItem(PUSHED_KEY)) || {};
      if (!state.pushed || typeof state.pushed !== "object") state.pushed = {};
    } catch (e) {
      state.pushed = {};
    }
    try {
      var dav = JSON.parse(store.getItem(DAV_KEY));
      if (dav && typeof dav === "object") {
        state.dav.server = dav.server || "";
        state.dav.username = dav.username || "";
        state.dav.password = dav.password || "";
        state.dav.dir = dav.dir || "/easynote";
      }
    } catch (e) {}
    applyTheme();
  }
  var syncInFlight = false;
  function save() {
    store.setItem(STORE_KEY, JSON.stringify(state.notes));
    if (state.token) scheduleSync();
  }
  function saveLocalOnly() {
    store.setItem(STORE_KEY, JSON.stringify(state.notes));
  }

  /* 落盘防抖：图片是内嵌 base64，带图笔记的内容动辄几 MB。
     如果每敲一个字都 JSON.stringify 全部笔记 + 写一次 localStorage，
     手机上会直接卡到没法继续输入（表现为「有图片的笔记无法再编辑」）。
     做法：内存里的 note.content 即时更新，持久化延后 600ms 并合并。 */
  var editorSaveTimer = null;
  var editorSavedTimer = null;
  function scheduleEditorSave() {
    if (el.saveFlag) el.saveFlag.textContent = "编辑中…";
    if (editorSavedTimer) { clearTimeout(editorSavedTimer); editorSavedTimer = null; }
    if (editorSaveTimer) clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(function () {
      editorSaveTimer = null;
      save();
      if (el.saveFlag) {
        el.saveFlag.textContent = "已保存 " + pad(new Date().getHours()) + ":" + pad(new Date().getMinutes());
        editorSavedTimer = setTimeout(function () { el.saveFlag.textContent = ""; }, 2000);
      }
    }, 600);
  }
  function flushEditorSave() {
    if (!editorSaveTimer) return;
    clearTimeout(editorSaveTimer);
    editorSaveTimer = null;
    if (el.saveFlag) el.saveFlag.textContent = "";
    save();
  }
  function filterPurged() {
    if (!state.purged.length) return;
    var before = state.notes.length;
    state.notes = state.notes.filter(function (n) {
      return state.purged.indexOf(n.id) === -1;
    });
    if (state.notes.length !== before) saveLocalOnly();
  }

  function isSystemDark() {
    if (window.matchMedia) {
      try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) {}
    }
    return state.systemDark;
  }
  function applyTheme() {
    var dark = state.themeMode === "dark" ||
      (state.themeMode === "auto" && isSystemDark());
    state.dark = dark;
    // 同步挂到 html（:root）与 body：html 的背景负责绘制刘海/状态栏那一行
    document.body.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("dark", dark);
    // 主题色：与 CSS 的 --bg 保持一致（浅色 #ffffff / 深色 #101216）
    var meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", dark ? "#101216" : "#ffffff");
    // 同步原生状态栏（深色模式用浅色文字）
    var sb = plugin("StatusBar");
    if (sb && sb.setStyle) {
      try {
        // 注意：这里**不要**调 setOverlaysWebView。
        // 插件内部 `if (overlay == isOverlayingWebview) return` 会短路，
        // 而"先关再开"虽然能触发 resizeWebView()，但那段代码依赖 keyWindow 的 bounds，
        // 在启动早期取值不可靠，会把 WebView 的 frame 算小 → 界面被挤到左边、右侧留白。
        // 状态栏底色改由原生侧（SceneDelegate）兜底。
        sb.setStyle({ style: dark ? "DARK" : "LIGHT" });
        sb.setBackgroundColor({ color: dark ? "#101216" : "#ffffff" });
      } catch (e) {}
    }
  }
  function setThemeMode(mode) {
    state.themeMode = mode;
    store.setItem(THEME_KEY, mode);
    applyTheme();
    renderAll();
  }

  /* ---------------- 工具 ---------------- */
  function uid() {
    return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  // 列表标题：交给共享核心（跳过纯图片行，避免把 base64 当标题）
  function getTitle(note) {
    return EZCore.noteTitle(note && note.content);
  }
  // 摘要：剥离 Markdown 图片/链接语法（避免 data: 大图撑爆列表），限长 120 字
  // 列表摘要：交给共享核心（图片→[图片]，链接留文字）
  function getSnippet(note) {
    return EZCore.noteSnippet(note && note.content);
  }
  function extractTags(content) {
    var tags = {};
    var re = /(?:^|\s)#([\u4e00-\u9fa5A-Za-z0-9_-]+)/g;
    var m;
    while ((m = re.exec(content))) tags[m[1].toLowerCase()] = true;
    return Object.keys(tags);
  }
  function formatDate(ts) {
    var d = new Date(ts);
    var now = new Date();
    var diff = (now - d) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400 && d.getDate() === now.getDate())
      return "今天 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    var y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.getDate() === y.getDate() && d.getMonth() === y.getMonth())
      return "昨天 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  /* ---------------- Markdown（与桌面端一致） ---------------- */

  /* ---------------- DOM ---------------- */
  var el = {};
  function cacheDom() {
    el.searchRow = document.getElementById("searchRow");
    el.search = document.getElementById("search");
    el.btnSearch = document.getElementById("btnSearch");
    el.btnSearchClose = document.getElementById("btnSearchClose");
    el.btnTheme = document.getElementById("btnTheme");
    el.btnListMenu = document.getElementById("btnListMenu");
    el.btnSort = document.getElementById("btnSort");
    el.syncPill = document.getElementById("syncPill");
    el.listTitle = document.getElementById("listTitle");
    el.tagChips = document.getElementById("tagChips");
    el.noteList = document.getElementById("noteList");
    el.newBtn = document.getElementById("newNoteBtn");
    el.appVersion = document.getElementById("appVersion");
    el.aboutVersion = document.getElementById("aboutVersion");
    el.updateBanner = document.getElementById("updateBanner");
    el.updateText = document.getElementById("updateText");
    el.updateDownloadBtn = document.getElementById("updateDownloadBtn");
    el.updateDismissBtn = document.getElementById("updateDismissBtn");
    el.imgFixBanner = document.getElementById("imgFixBanner");
    el.imgFixText = document.getElementById("imgFixText");
    el.imgFixDismissBtn = document.getElementById("imgFixDismissBtn");
    el.btnBack = document.getElementById("btnBack");
    el.editorTitle = document.getElementById("editorTitle");
    el.saveFlag = document.getElementById("saveFlag");
    el.btnEditorMore = document.getElementById("btnEditorMore");
    el.editorToolbar = document.getElementById("editorToolbar");
    el.editor = document.getElementById("editor");
    el.previewPane = document.getElementById("previewPane");
    el.editorEmpty = document.getElementById("editorEmpty");
    el.btnSettingsBack = document.getElementById("btnSettingsBack");
    el.serverUrl = document.getElementById("serverUrl");
    el.accUser = document.getElementById("accUser");
    el.accPass = document.getElementById("accPass");
    el.btnTestConn = document.getElementById("btnTestConn");
    el.btnLogin = document.getElementById("btnLogin");
    el.btnRegister = document.getElementById("btnRegister");
    el.btnSync = document.getElementById("btnSync");
    el.btnLogout = document.getElementById("btnLogout");
    el.accLoggedOut = document.getElementById("accLoggedOut");
    el.accLoggedIn = document.getElementById("accLoggedIn");
    el.accName = document.getElementById("accName");
    el.syncStatus = document.getElementById("syncStatus");
    el.btnEmptyTrash = document.getElementById("btnEmptyTrash");
    el.trashDaysSelect = document.getElementById("trashDaysSelect");
    el.trashBar = document.getElementById("trashBar");
    el.trashAll = document.getElementById("trashAll");
    el.trashCount = document.getElementById("trashCount");
    el.trashRestoreSel = document.getElementById("trashRestoreSel");
    el.trashPurgeSel = document.getElementById("trashPurgeSel");
    el.appbarTitle = document.getElementById("appbarTitle");
    el.btnDrawer = document.getElementById("btnDrawer");
    el.drawer = document.getElementById("drawer");
    el.drawerMask = document.getElementById("drawerMask");
    el.drawerCountNotes = document.getElementById("drawerCountNotes");
    el.drawerCountTrash = document.getElementById("drawerCountTrash");
    el.themeModeSelect = document.getElementById("themeModeSelect");
    el.fontSelect = document.getElementById("fontSelect");
    el.fontCustom = document.getElementById("fontCustom");
    el.fontCustomApply = document.getElementById("fontCustomApply");
    el.fontSizeSelect = document.getElementById("fontSizeSelect");
    el.imgFixStatus = document.getElementById("imgFixStatus");
    el.btnEmbedImages = document.getElementById("btnEmbedImages");
    el.btnExport = document.getElementById("btnExport");
    el.btnImport = document.getElementById("btnImport");
    el.importFile = document.getElementById("importFile");
    el.davUrl = document.getElementById("davUrl");
    el.davUser = document.getElementById("davUser");
    el.davPass = document.getElementById("davPass");
    el.davDir = document.getElementById("davDir");
    el.btnDavTest = document.getElementById("btnDavTest");
    el.btnDavExport = document.getElementById("btnDavExport");
    el.btnCheckUpdate = document.getElementById("btnCheckUpdate");
    el.linkModal = document.getElementById("linkModal");
    el.linkUrl = document.getElementById("linkUrl");
    el.linkText = document.getElementById("linkText");
    el.linkConfirm = document.getElementById("linkConfirm");
    el.linkCancel = document.getElementById("linkCancel");
    el.infoModal = document.getElementById("infoModal");
    el.infoBody = document.getElementById("infoBody");
    el.infoClose = document.getElementById("infoClose");
    el.sheetMask = document.getElementById("sheetMask");
    el.actionSheet = document.getElementById("actionSheet");
    el.sheetTitle = document.getElementById("sheetTitle");
    el.sheetItems = document.getElementById("sheetItems");
    el.sheetCancel = document.getElementById("sheetCancel");
    el.toast = document.getElementById("toast");
  }

  /* ---------------- 过滤 / 排序 ---------------- */
  function getNotes() {
    var inTrash = state.view === "trash";
    var list = state.notes.filter(function (n) {
      return !!n.deleted === inTrash;
    });
    if (state.view === "notes" && state.activeTag) {
      list = list.filter(function (n) {
        return extractTags(n.content).indexOf(state.activeTag) !== -1;
      });
    }
    if (state.query) {
      var q = state.query.toLowerCase();
      list = list.filter(function (n) {
        return (n.content || "").toLowerCase().indexOf(q) !== -1 ||
          extractTags(n.content).some(function (t) { return t.indexOf(q) !== -1; });
      });
    }
    list.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (state.sort === "title") return getTitle(a).localeCompare(getTitle(b), "zh");
      if (state.sort === "created") return b.createdDate - a.createdDate;
      return b.modifiedDate - a.modifiedDate;
    });
    return list;
  }

  /* ---------------- 渲染 ---------------- */
  function renderTags() {
    var tagSet = {};
    state.notes.filter(function (n) { return !n.deleted; }).forEach(function (n) {
      extractTags(n.content).forEach(function (t) { tagSet[t] = true; });
    });
    var tags = Object.keys(tagSet).sort();
    el.tagChips.innerHTML = "";
    if (!tags.length) return;
    var all = document.createElement("button");
    all.className = "chip" + (state.activeTag ? "" : " active");
    all.textContent = "全部";
    all.addEventListener("click", function () {
      state.activeTag = null;
      renderAll();
    });
    el.tagChips.appendChild(all);
    tags.forEach(function (t) {
      var c = document.createElement("button");
      c.className = "chip" + (state.activeTag === t ? " active" : "");
      c.textContent = "#" + t;
      c.addEventListener("click", function () {
        state.activeTag = state.activeTag === t ? null : t;
        state.view = "notes";
        renderAll();
      });
      el.tagChips.appendChild(c);
    });
  }

  function renderList() {
    var list = getNotes();
    el.noteList.innerHTML = "";
    // 列表重绘后旧的滑动行已经不存在了，清掉残留的「收起」引用
    swipeClose = null;
    if (list.length === 0) {
      var hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = state.view === "trash" ? "回收站为空" :
        (state.query || state.activeTag ? "没有匹配的笔记" : "还没有笔记，点右下角「＋」新建");
      el.noteList.appendChild(hint);
      updateTrashBar();
      return;
    }
    list.forEach(function (n) {
      var row = document.createElement("div");
      row.className = "swipe-row";
      var item = document.createElement("div");
      // 回收站不用「选中高亮」——那里用勾选框表达选中，两种高亮叠在一起会让人以为
      // 第一条默认被选中（其实只是删除前打开过的那条）
      item.className = "note-card" +
        (n.id === state.currentId && state.view !== "trash" ? " selected" : "");
      item.setAttribute("data-id", n.id);

      var top = document.createElement("div");
      top.className = "card-top";
      if (n.color) {
        var dot = document.createElement("span");
        dot.className = "color-dot";
        dot.style.background = colorOf(n.color).color;
        top.appendChild(dot);
      }
      var title = document.createElement("span");
      title.className = "card-title";
      title.textContent = getTitle(n);
      top.appendChild(title);
      if (n.pinned) {
        var pin = document.createElement("span");
        pin.className = "card-pin";
        pin.textContent = "📌";
        top.appendChild(pin);
      }

      var snip = document.createElement("div");
      snip.className = "card-snippet";
      snip.textContent = getSnippet(n) || "没有更多文字";

      var meta = document.createElement("div");
      meta.className = "card-meta";
      var date = document.createElement("span");
      date.textContent = formatDate(n.modifiedDate);
      meta.appendChild(date);
      if (n.markdown) {
        var md = document.createElement("span");
        md.textContent = "Markdown";
        meta.appendChild(md);
      }
      extractTags(n.content).slice(0, 3).forEach(function (t) {
        var tg = document.createElement("span");
        tg.className = "card-tag";
        tg.textContent = "#" + t;
        meta.appendChild(tg);
      });

      item.appendChild(top);
      item.appendChild(snip);
      item.appendChild(meta);

      // 回收站：列表里直接给一个「♻ 恢复」，不用先进详情页再点工具条
      if (state.view === "trash") {
        item.classList.add("is-trash", "has-check");
        // 勾选框：点它只切换选中，不要顺带打开笔记（移动端很容易点错）
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "card-check";
        cb.checked = !!state.selected[n.id];
        cb.setAttribute("aria-label", "选择这条笔记");
        cb.addEventListener("click", function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          setSelected(n.id, cb.checked);
        });
        item.appendChild(cb);
        var restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "card-restore";
        restoreBtn.textContent = "♻ 恢复";
        restoreBtn.title = "恢复到笔记";
        restoreBtn.addEventListener("click", function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          handleAction("restore", n);
        });
        item.appendChild(restoreBtn);
      }

      // 点击打开；长按（或鼠标右键）出操作面板
      item.addEventListener("click", function () {
        // 长按刚弹过面板、或刚做完滑动手势：浏览器还会补发一个 click，这里吞掉，
        // 否则会出现"点开面板的同时笔记也被打开了"的错乱。
        if (Date.now() < suppressClickUntil) return;
        // 这一行正被滑开：任意点击先把它收回去，而不是打开笔记
        if (row.dataset.open === "1") { closeOpenSwipe(); return; }
        selectNote(n.id);
      });
      bindLongPress(item, n);

      // 卡片下面垫两个动作层：左滑露出右侧「删除」，右滑露出左侧「编辑 / 恢复」
      var actEdit = document.createElement("button");
      actEdit.type = "button";
      actEdit.className = "swipe-act act-edit";
      actEdit.innerHTML = state.view === "trash"
        ? '<span class="swipe-ico">♻</span><span>恢复</span>'
        : '<span class="swipe-ico">✏️</span><span>编辑</span>';
      actEdit.addEventListener("click", function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        closeOpenSwipe();
        swipePrimary(n);
      });

      var actDel = document.createElement("button");
      actDel.type = "button";
      actDel.className = "swipe-act act-del";
      actDel.innerHTML = state.view === "trash"
        ? '<span class="swipe-ico">🗑</span><span>永久删除</span>'
        : '<span class="swipe-ico">🗑</span><span>删除</span>';
      actDel.addEventListener("click", function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        closeOpenSwipe();
        swipeDelete(n);
      });

      row.appendChild(actEdit);
      row.appendChild(actDel);
      row.appendChild(item);
      bindSwipe(row, item, n);
      el.noteList.appendChild(row);
    });
    updateTrashBar();
  }

  /* ---------------- 回收站：勾选 / 全选 / 批量操作 ---------------- */
  function setSelected(id, on) {
    if (on) state.selected[id] = true;
    else delete state.selected[id];
    updateTrashBar();
  }

  function updateTrashBar() {
    var inTrash = state.view === "trash";
    // 离开回收站就清空勾选，避免下次进来"莫名其妙已选了几条"
    if (!inTrash) state.selected = {};
    var list = inTrash ? getNotes() : [];
    // 回收站为空时整条工具栏收起来（原来会留一条"已选 0 / 0 条"的空条）
    if (el.trashBar) el.trashBar.hidden = !inTrash || list.length === 0;
    if (!inTrash) return;
    var alive = {};
    list.forEach(function (n) { alive[n.id] = true; });
    // 搜索 / 刷新后，把已经不在列表里的勾选清掉，避免"看不见却被删掉"
    Object.keys(state.selected).forEach(function (id) {
      if (!alive[id]) delete state.selected[id];
    });
    var sel = list.filter(function (n) { return state.selected[n.id]; }).length;
    if (el.trashCount) el.trashCount.textContent = "已选 " + sel + " / " + list.length + " 条";
    if (el.trashRestoreSel) el.trashRestoreSel.disabled = sel === 0;
    if (el.trashPurgeSel) el.trashPurgeSel.disabled = sel === 0;
    if (el.trashAll) {
      el.trashAll.checked = list.length > 0 && sel === list.length;
      el.trashAll.indeterminate = sel > 0 && sel < list.length;
      el.trashAll.disabled = list.length === 0;
    }
  }

  function selectedTrashNotes() {
    return getNotes().filter(function (n) { return state.selected[n.id]; });
  }

  function restoreSelected() {
    var sel = selectedTrashNotes();
    if (!sel.length) return;
    var now = Date.now();
    sel.forEach(function (n) { n.deleted = false; n.deletedDate = null; n.modifiedDate = now; });
    state.selected = {};
    save();
    renderAll();
    toast("已恢复 " + sel.length + " 条笔记");
  }

  function purgeSelected() {
    var sel = selectedTrashNotes();
    if (!sel.length) return;
    var ids = sel.map(function (n) { return n.id; });
    openConfirm(
      "永久删除 " + ids.length + " 条",
      "这 " + ids.length + " 条笔记将被永久删除、无法恢复，并从所有设备上一起删除。",
      function () {
        purgeMany(ids);
        toast("已永久删除 " + ids.length + " 条");
      }
    );
  }

  // 回收站自动清理：启动时把超过设定天数的已删笔记永久删除（墓碑 + 上报服务端）
  function autoPurgeTrash() {
    var days = state.trashAutoDays || 0;
    if (days <= 0) return 0;
    var cutoff = Date.now() - days * 86400000;
    var ids = state.notes
      .filter(function (n) { return !!n.deleted && (n.deletedDate || n.modifiedDate || 0) < cutoff; })
      .map(function (n) { return n.id; });
    if (!ids.length) return 0;
    ids.forEach(function (id) {
      if (state.purged.indexOf(id) === -1) state.purged.push(id);
    });
    store.setItem(PURGE_KEY, JSON.stringify(state.purged));
    state.notes = state.notes.filter(function (n) { return ids.indexOf(n.id) === -1; });
    if (ids.indexOf(state.currentId) !== -1) state.currentId = null;
    saveLocalOnly();
    purgeOnServer(ids);
    return ids.length;
  }

  // 统一入口：墓碑记账 + 本地删除 + 上报服务端 + 保存渲染
  function purgeMany(ids) {
    if (!ids || !ids.length) return;
    ids.forEach(function (id) {
      if (state.purged.indexOf(id) === -1) state.purged.push(id);
      delete state.selected[id];
    });
    store.setItem(PURGE_KEY, JSON.stringify(state.purged));
    state.notes = state.notes.filter(function (n) { return ids.indexOf(n.id) === -1; });
    if (ids.indexOf(state.currentId) !== -1) state.currentId = null;
    purgeOnServer(ids);
    save();
    renderAll();
  }

  var LONG_PRESS_MS = 480;
  var suppressClickUntil = 0;
  function bindLongPress(node, note) {
    var timer = null;
    var fired = false;
    function start(x, y) {
      fired = false;
      timer = setTimeout(function () {
        fired = true;
        suppressClickUntil = Date.now() + 600;
        openNoteSheet(note);
      }, LONG_PRESS_MS);
    }
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    node.addEventListener("touchstart", function (e) {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    node.addEventListener("touchmove", cancel, { passive: true });
    node.addEventListener("touchend", cancel, { passive: true });
    node.addEventListener("touchcancel", cancel, { passive: true });
    node.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      suppressClickUntil = Date.now() + 600;
      openNoteSheet(note);
    });
  }

  /* ---------------- 列表手势：左滑删除 / 右滑编辑 ---------------- */
  // 结构：.swipe-row（overflow:hidden）里垫两个 .swipe-act 动作层，卡片在最上面横向平移。
  //   左滑 → 露出右侧「删除」；右滑 → 露出左侧「编辑」（回收站里是「恢复」）。
  //   滑过约半个卡片宽度就直接执行动作，不用再点按钮（与邮件类 App 的手感一致）。
  var SWIPE_W = 92;      // 松手后停留的位置 = 动作层宽度
  var swipeClose = null; // 当前打开的那一行的收起函数（同一时刻只允许一行展开）

  function closeOpenSwipe() {
    if (swipeClose) { var f = swipeClose; swipeClose = null; f(); }
  }

  // 右滑：笔记 → 打开编辑器；回收站 → 恢复
  function swipePrimary(note) {
    if (state.view === "trash") { handleAction("restore", note); return; }
    selectNote(note.id);
  }

  // 左滑：笔记 → 移入回收站（带撤销）；回收站 → 永久删除（不可逆，仍然弹确认）
  function swipeDelete(note) {
    if (state.view === "trash") { handleAction("purge", note); return; }
    var id = note.id;
    // 置顶状态在删除时被清掉，撤销要还原 —— 否则"删掉置顶笔记再撤销"会莫名掉到列表中间
    var wasPinned = !!note.pinned;
    note.deleted = true;
    note.deletedDate = Date.now();
    note.pinned = false;
    note.modifiedDate = Date.now();
    if (state.currentId === id) state.currentId = null;
    save();
    renderAll();
    // 撤销时按 id 重新取一遍：3 秒一轮的同步可能已经把对象换成新的了
    toast("已移到回收站", "撤销", function () { restoreById(id, wasPinned); });
  }

  function restoreById(id, wasPinned) {
    var target = null;
    state.notes.forEach(function (n) { if (n.id === id) target = n; });
    if (!target) return;
    target.deleted = false;
    target.deletedDate = null;
    if (wasPinned) target.pinned = true;
    target.modifiedDate = Date.now();
    save();
    renderAll();
    toast("已恢复");
  }

  function bindSwipe(row, card, note) {
    var startX = 0, startY = 0, baseX = 0, x = 0, raw = 0;
    var tracking = false, decided = false, horizontal = false;

    // px 是实际（已经加过阻尼）的位移，raw 是手指真实走了多远：
    // "整条滑完就执行"要按 raw 判断，否则阻尼把位移压回 92px 附近，永远达不到阈值。
    function move(px, anim, rawPx) {
      x = px;
      raw = typeof rawPx === "number" ? rawPx : px;
      card.style.transition = anim ? "transform .22s cubic-bezier(.22,.7,.3,1)" : "none";
      card.style.transform = px ? "translateX(" + px + "px)" : "";
      if (px) row.dataset.open = "1";
      else delete row.dataset.open;
    }

    function openAt(px) {
      closeOpenSwipe();
      move(px, true);
      swipeClose = function () { move(0, true); };
    }

    card.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) return;
      // 摸到别的行 → 先把展开的那行收回去；这一下只当"收起"，不顺手打开被点的笔记
      // （与 iOS 邮件/备忘录的手感一致：第一下取消，第二下才进入）
      if (row.dataset.open !== "1" && swipeClose) {
        closeOpenSwipe();
        suppressClickUntil = Date.now() + 450;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      baseX = x;
      tracking = true;
      decided = false;
      horizontal = false;
    }, { passive: true });

    card.addEventListener("touchmove", function (e) {
      if (!tracking) return;
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        // 明显偏竖向就当成滚动，把手势交还给列表（否则列表会卡住滑不动）
        horizontal = Math.abs(dx) > Math.abs(dy) * 1.3;
        if (!horizontal) { tracking = false; return; }
        baseX = x;
      }
      if (!horizontal) return;
      if (e.cancelable) e.preventDefault();
      // 越过停留位置后加阻尼，手感更接近原生
      var px = baseX + dx;
      if (px > SWIPE_W) px = SWIPE_W + (px - SWIPE_W) * 0.3;
      else if (px < -SWIPE_W) px = -SWIPE_W + (px + SWIPE_W) * 0.3;
      move(px, false, baseX + dx);
    }, { passive: false });

    function end() {
      if (!tracking) return;
      tracking = false;
      if (!horizontal) return;
      suppressClickUntil = Date.now() + 350; // 吞掉手势结束后补发的 click
      // 手指走过卡片宽度的 45%（最多 180px）就算"整条滑完"，直接执行动作
      var full = Math.min(180, (row.clientWidth || 320) * 0.45);
      if (raw <= -full) { move(0, true); swipeDelete(note); }
      else if (raw >= full) { move(0, true); swipePrimary(note); }
      else if (x <= -SWIPE_W * 0.45) openAt(-SWIPE_W);
      else if (x >= SWIPE_W * 0.45) openAt(SWIPE_W);
      else move(0, true);
    }
    card.addEventListener("touchend", end);
    card.addEventListener("touchcancel", function () {
      tracking = false;
      move(0, true);
    });
  }

  function setToolbar(note) {
    if (note && note.deleted) {
      // 回收站里的笔记：只保留真正可用的操作，并做成带文字的显式按钮
      // （以前回收站复用了编辑态工具条，没有「恢复」，只能长按列表项弹面板）
      el.editorToolbar.classList.add("is-trash");
      el.editorToolbar.innerHTML =
        '<button data-action="restore" class="text-action primary" title="恢复到笔记">♻ 恢复</button>' +
        '<button data-action="purge" class="text-action danger" title="永久删除">🗑 永久删除</button>' +
        '<button data-action="info" title="笔记信息">ⓘ</button>';
    } else {
      el.editorToolbar.classList.remove("is-trash");
      el.editorToolbar.innerHTML =
        '<button data-action="pin" class="' + (note.pinned ? "active" : "") + '" title="置顶 / 取消置顶">📌</button>' +
        '<button data-action="color" class="' + (note.color ? "active" : "") + '" title="设置颜色标签">●</button>' +
        '<button data-action="markdown" class="' + (note.markdown ? "active" : "") + '" title="开启 / 关闭 Markdown">M↓</button>' +
        '<button data-action="preview" class="' + (state.preview ? "active" : "") + '" title="预览" ' + (note.markdown ? "" : "disabled") + ">👁</button>" +
        '<button data-action="insertText" title="插入文本（引用/代码/分隔线/日期）">文</button>' +
        '<button data-action="insertImage" title="插入图片（拍照 / 相册）">🖼</button>' +
        '<button data-action="insertLink" title="插入链接">🔗</button>' +
        '<button data-action="info" title="笔记信息">ⓘ</button>' +
        '<button data-action="share" title="分享 / 复制">↗</button>' +
        '<button data-action="trash" title="移到回收站">🗑</button>';
    }
    var btns = el.editorToolbar.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        handleAction(this.getAttribute("data-action"), note);
      });
    }
  }

  function renderEditor() {
    var note = currentNote();
    var valid = !!note && !!note.deleted === (state.view === "trash");
    document.body.setAttribute("data-note", valid ? "yes" : "none");
    el.editorTitle.textContent = valid ? getTitle(note) : "简易笔记";

    if (!valid) {
      el.editorEmpty.hidden = false;
      el.editor.hidden = true;
      el.previewPane.hidden = true;
      el.editorToolbar.hidden = true;
      el.editorToolbar.innerHTML = "";
      return;
    }
    el.editorEmpty.hidden = true;
    el.editorToolbar.hidden = false;
    el.editor.readOnly = state.view === "trash";
    setToolbar(note);

    if (state.preview && note.markdown && !note.deleted) {
      // 「开着预览就没法加文字」：以前这里把编辑器整个隐藏了。
      // 改成上下分栏——上面渲染结果（能看图），下面仍是输入框，可继续打字。
      el.previewPane.hidden = false;
      el.previewPane.classList.add("split");
      el.previewPane.innerHTML = renderMarkdown(note.content);
      el.editor.hidden = false;
      if (document.activeElement !== el.editor) el.editor.value = note.content;
    } else {
      el.editor.hidden = false;
      el.previewPane.hidden = true;
      el.previewPane.classList.remove("split");
      if (document.activeElement !== el.editor) el.editor.value = note.content;
    }
  }

  function renderAll() {
    document.body.setAttribute("data-view", state.view);
    // 顶栏标题跟随当前列表（Simplenote 那样一眼看清在哪个列表里）
    if (el.appbarTitle) {
      el.appbarTitle.textContent = state.view === "trash" ? "回收站" :
        (state.activeTag ? "#" + state.activeTag : "笔记");
    }
    el.btnTheme.textContent = state.dark ? "☀" : "🌙";
    // 回收站视图且有内容时显示「清空回收站」
    if (el.btnEmptyTrash) {
      var trashed = state.view === "trash" && getNotes().length > 0;
      el.btnEmptyTrash.hidden = !trashed;
    }
    renderTags();
    updateDrawer();
    var list = getNotes();
    var cur = currentNote();
    if (!cur || !!cur.deleted !== (state.view === "trash")) {
      state.currentId = list.length ? list[0].id : null;
    }
    renderList();
    renderEditor();
  }
  // 切换视图时只刷新列表相关 UI（避免每次全量 renderAll 造成的卡顿 / 生硬）
  function refreshListView() {
    document.body.setAttribute("data-view", state.view);
    // 顶栏标题跟随当前列表（Simplenote 那样一眼看清在哪个列表里）
    if (el.appbarTitle) {
      el.appbarTitle.textContent = state.view === "trash" ? "回收站" :
        (state.activeTag ? "#" + state.activeTag : "笔记");
    }
    el.btnTheme.textContent = state.dark ? "☀" : "🌙";
    if (el.btnEmptyTrash) {
      var trashed = state.view === "trash" && getNotes().length > 0;
      el.btnEmptyTrash.hidden = !trashed;
    }
    updateDrawer();
    var list = getNotes();
    var cur = currentNote();
    if (!cur || !!cur.deleted !== (state.view === "trash")) {
      state.currentId = list.length ? list[0].id : null;
    }
    renderList();
  }

  /* ---------------- 屏幕导航 ---------------- */
  function isWide() {
    return window.matchMedia && window.matchMedia("(min-width: 720px)").matches;
  }
  function setScreen(name) {
    document.body.setAttribute("data-screen", name);
    if (name === "settings") refreshSettingsUI();
  }
  function goList() {
    flushEditorSave();   // 离开编辑器前把待落盘的改动写掉
    state.preview = false;
    setScreen("list");
    renderAll();
  }
  function goSettings() {
    flushEditorSave();
    setScreen("settings");
  }
  function goEditor(id) {
    state.currentId = id;
    state.preview = false;
    renderEditor();
    if (!isWide()) setScreen("editor");
    else renderAll();
  }

  /* ---------------- 侧边抽屉菜单（Simplenote 风格） ----------------
   * 笔记 / 回收站 / 设置 收在二级菜单里，主页面只有搜索栏 + 列表 + 新建按钮。 */
  function updateDrawer() {
    if (!el.drawer) return;
    var items = el.drawer.querySelectorAll(".drawer-item");
    var onSettings = document.body.getAttribute("data-screen") === "settings";
    var target = onSettings ? "settings" : (state.view === "trash" ? "trash" : "notes");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("active", items[i].getAttribute("data-view") === target);
    }
    // 数量小徽标：笔记为未删除条数，回收站为已删除条数
    var allNotes = state.notes || [];
    var alive = 0, dead = 0;
    for (var j = 0; j < allNotes.length; j++) {
      if (allNotes[j] && allNotes[j].deleted) dead++; else alive++;
    }
    if (el.drawerCountNotes) el.drawerCountNotes.textContent = alive ? String(alive) : "";
    if (el.drawerCountTrash) el.drawerCountTrash.textContent = dead ? String(dead) : "";
  }
  function openDrawer() {
    if (!el.drawer) return;
    updateDrawer();
    el.drawer.hidden = false;
    if (el.drawerMask) el.drawerMask.hidden = false;
    // 下一帧再加 class，才会有滑入动画
    requestAnimationFrame(function () { el.drawer.classList.add("show"); });
  }
  function closeDrawer() {
    if (!el.drawer) return;
    el.drawer.classList.remove("show");
    if (el.drawerMask) el.drawerMask.hidden = true;
    setTimeout(function () {
      if (el.drawer && !el.drawer.classList.contains("show")) el.drawer.hidden = true;
    }, 220);
  }

  /* ---------------- 行为 ---------------- */
  function selectNote(id) {
    if (isWide()) { state.currentId = id; state.preview = false; renderAll(); return; }
    goEditor(id);
  }

  function createNote() {
    var now = Date.now();
    var note = {
      id: uid(), content: "", pinned: false, markdown: false,
      deleted: false, color: "", createdDate: now, modifiedDate: now,
    };
    state.notes.unshift(note);
    state.currentId = note.id;
    state.view = "notes";
    state.activeTag = null;
    state.query = "";
    el.search.value = "";
    state.preview = false;
    save();
    renderAll();
    if (!isWide()) setScreen("editor");
    setTimeout(function () { el.editor.focus(); }, 30);
  }

  // 弹窗里给笔记一个可读的名字（取首行、去掉 Markdown 符号，最长 24 字）
  function noteCaption(note) {
    var first = String((note && note.content) || "").split("\n")[0] || "";
    var t = first.replace(/^[#>\-\*\s]+/, "").trim();
    if (!t) return "无标题";
    return t.length > 24 ? t.slice(0, 24) + "…" : t;
  }

  function handleAction(action, note) {
    switch (action) {
      case "pin":
        note.pinned = !note.pinned; note.modifiedDate = Date.now(); save(); renderAll(); break;
      case "markdown":
        note.markdown = !note.markdown; if (!note.markdown) state.preview = false; save(); renderAll(); break;
      case "preview":
        if (note.markdown) { state.preview = !state.preview; renderEditor(); } break;
      case "info":
        showInfo(note); break;
      case "share":
        shareNote(note); break;
      case "trash":
        openConfirm("移到回收站",
          "「" + noteCaption(note) + "」将被移到回收站，可在回收站里恢复。",
          function () {
            note.deleted = true; note.deletedDate = Date.now(); note.pinned = false; note.modifiedDate = Date.now();
            state.currentId = null; save(); renderAll();
            if (!isWide()) goList();
            toast("已移到回收站");
          });
        break;
      case "restore":
        note.deleted = false; note.deletedDate = null; note.modifiedDate = Date.now(); save(); renderAll();
        toast("已恢复"); break;
      case "purge":
        openConfirm("永久删除",
          "「" + noteCaption(note) + "」将被永久删除，不可恢复，并同步删除所有设备上的这一条。",
          function () {
            if (state.purged.indexOf(note.id) === -1) {
              state.purged.push(note.id);
              store.setItem(PURGE_KEY, JSON.stringify(state.purged));
            }
            state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
            if (state.currentId === note.id) state.currentId = null;
            purgeOnServer([note.id]);
            save(); renderAll();
            toast("已永久删除");
          });
        break;
      case "color":
        openColorSheet(note); break;
      case "insertText":
        openInsertTextSheet(); break;
      case "insertImage":
        openImageSourceSheet(); break;
      case "insertLink":
        insertLink(); break;
    }
  }

  /* ---------------- 底部动作面板 ---------------- */
  var sheetOnCancel = null;
  // 通用确认弹窗（复用 .modal 样式）：标题 + 说明 + 取消/确认
  function openConfirm(title, msg, onYes) {
    var m = document.createElement("div");
    m.className = "modal";
    var box = document.createElement("div");
    box.className = "modal-box";
    var h = document.createElement("h3"); h.textContent = title || "确认";
    var p = document.createElement("p"); p.textContent = msg || "";
    var actions = document.createElement("div"); actions.className = "modal-actions";
    var cancel = document.createElement("button"); cancel.className = "btn"; cancel.textContent = "取消";
    var yes = document.createElement("button"); yes.className = "btn danger"; yes.textContent = "确认";
    actions.appendChild(cancel); actions.appendChild(yes);
    box.appendChild(h); box.appendChild(p); box.appendChild(actions); m.appendChild(box);
    document.body.appendChild(m);
    function close() { if (m.parentNode) m.parentNode.removeChild(m); }
    cancel.addEventListener("click", close);
    m.addEventListener("click", function (e) { if (e.target === m) close(); });
    yes.addEventListener("click", function () { close(); if (onYes) onYes(); });
    requestAnimationFrame(function () { m.removeAttribute("hidden"); });
    return close;
  }
  function showSheet(title, items, onCancel) {
    sheetOnCancel = onCancel || null;
    el.sheetTitle.textContent = title || "";
    el.sheetTitle.hidden = !title;
    el.sheetItems.innerHTML = "";
    items.forEach(function (it) {
      var row = document.createElement("button");
      row.className = "sheet-item" + (it.danger ? " danger" : "");
      row.setAttribute("type", "button");
      if (it.disabled) row.disabled = true;
      if (it.dot) {
        var d = document.createElement("span");
        d.className = "dot";
        d.style.background = it.dot;
        row.appendChild(d);
      }
      var lbl = document.createElement("span");
      lbl.textContent = it.label;
      row.appendChild(lbl);
      if (it.checked) {
        var ck = document.createElement("span");
        ck.className = "check";
        ck.textContent = "✓";
        row.appendChild(ck);
      }
      row.addEventListener("click", function () {
        hideSheet();
        if (it.action) it.action();
      });
      el.sheetItems.appendChild(row);
    });
    el.sheetMask.hidden = false;
    el.actionSheet.hidden = false;
  }
  function hideSheet() {
    el.sheetMask.hidden = true;
    el.actionSheet.hidden = true;
  }

  function openNoteSheet(note) {
    var inTrash = state.view === "trash";
    var items = inTrash ? [
      { label: "打开", action: function () { selectNote(note.id); } },
      { label: "恢复到笔记", action: function () { handleAction("restore", note); } },
      { label: "永久删除", danger: true, action: function () { handleAction("purge", note); } },
    ] : [
      { label: "打开", action: function () { selectNote(note.id); } },
      { label: note.pinned ? "取消置顶" : "置顶", action: function () { handleAction("pin", note); } },
      { label: "设置颜色…", dot: note.color ? colorOf(note.color).color : null, action: function () { handleAction("color", note); } },
      { label: note.markdown ? "关闭 Markdown" : "开启 Markdown", action: function () { handleAction("markdown", note); } },
      { label: "复制内容到剪贴板", action: function () { copyText(note.content); toast("已复制笔记内容"); } },
      { label: "分享", action: function () { shareNote(note); } },
      { label: "笔记信息", action: function () { showInfo(note); } },
      { label: "移动到回收站", danger: true, action: function () { handleAction("trash", note); } },
    ];
    showSheet(getTitle(note), items);
  }

  function openColorSheet(note) {
    var items = COLOR_PALETTE.map(function (c) {
      return {
        label: (c.color ? "● " : "○ ") + c.name,
        dot: c.color || "transparent",
        checked: note.color === c.key,
        action: function () {
          note.color = c.key;
          note.modifiedDate = Date.now();
          save(); renderAll();
          toast(c.key ? "已设置颜色：" + c.name : "已清除颜色");
        },
      };
    });
    showSheet("设置颜色标签", items);
  }

  function openInsertTextSheet() {
    showSheet("插入文本元素", [
      { label: "引用块", action: function () { insertTextElement("quote"); } },
      { label: "代码块", action: function () { insertTextElement("code"); } },
      { label: "分隔线", action: function () { insertTextElement("hr"); } },
      { label: "当前日期时间", action: function () { insertTextElement("datetime"); } },
      { label: "待办清单", action: function () { insertChecklist(); } },
    ]);
  }

  function openSortSheet() {
    showSheet("排序方式", [
      { label: "按修改时间", checked: state.sort === "modified", action: function () { state.sort = "modified"; renderAll(); } },
      { label: "按创建时间", checked: state.sort === "created", action: function () { state.sort = "created"; renderAll(); } },
      { label: "按标题", checked: state.sort === "title", action: function () { state.sort = "title"; renderAll(); } },
    ]);
  }

  function openListMenuSheet() {
    showSheet("更多操作", [
      { label: "排序方式", action: openSortSheet },
      { label: "导出备份（JSON）", action: exportBackup },
      { label: "导入备份", action: function () { el.importFile.click(); } },
      { label: state.dark ? "切换到浅色模式" : "切换到深色模式", action: function () { setThemeMode(state.dark ? "light" : "dark"); } },
      { label: "设置", action: goSettings },
    ]);
  }

  function openEditorMoreSheet() {
    var note = currentNote();
    if (!note) return;
    showSheet(getTitle(note), [
      { label: "复制内容到剪贴板", action: function () { copyText(note.content); toast("已复制笔记内容"); } },
      { label: "分享", action: function () { shareNote(note); } },
      { label: "笔记信息", action: function () { showInfo(note); } },
      { label: "移动到回收站", danger: true, action: function () { handleAction("trash", note); } },
    ]);
  }

  /* ---------------- 信息 / 分享 / 剪贴板 ---------------- */
  function showInfo(note) {
    var content = note.content || "";
    var words = content.trim() ? (content.trim().match(/[\u4e00-\u9fa5]|[A-Za-z0-9]+/g) || []).length : 0;
    var tags = extractTags(note.content);
    var lastSync = state.lastSyncTs
      ? new Date(state.lastSyncTs).toLocaleString("zh-CN")
      : (state.token ? "尚未同步" : "未登录云同步");
    el.infoBody.innerHTML =
      "<p><b>创建时间：</b>" + new Date(note.createdDate).toLocaleString("zh-CN") + "</p>" +
      "<p><b>修改时间：</b>" + new Date(note.modifiedDate).toLocaleString("zh-CN") + "</p>" +
      "<p><b>最后同步：</b>" + lastSync + "</p>" +
      "<p><b>字符数：</b>" + content.length + "　<b>词数：</b>" + words + "</p>" +
      "<p><b>标签：</b>" + (tags.length ? tags.map(function (t) { return "#" + t; }).join(" ") : "无") + "</p>" +
      "<p><b>颜色：</b>" + (note.color ? colorOf(note.color).name : "无") + "　<b>Markdown：</b>" + (note.markdown ? "已开启" : "未开启") + "　<b>置顶：</b>" + (note.pinned ? "是" : "否") + "</p>";
    el.infoModal.hidden = false;
  }

  function copyText(text) {
    var cb = plugin("Clipboard");
    if (cb && cb.write) {
      cb.write({ string: text }).then(function () {}, function () { webCopy(text); });
      return;
    }
    webCopy(text);
  }
  function webCopy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  function shareNote(note) {
    var share = plugin("Share");
    var text = note.content || "";
    if (share && share.share) {
      share.share({ title: getTitle(note), text: text, dialogTitle: "分享笔记" })
        .catch(function () { copyText(text); toast("已复制笔记内容（分享不可用）"); });
    } else {
      copyText(text);
      toast("已复制笔记内容到剪贴板");
    }
  }

  var toastTimer;
  // 支持带一个操作按钮（如「撤销」）：滑动手势删除后可以一键反悔，
  // 否则误滑一下就得去回收站里捞回来。
  function toast(msg, actionLabel, actionFn) {
    var t = el.toast;
    t.innerHTML = "";
    var span = document.createElement("span");
    span.textContent = msg;
    t.appendChild(span);
    if (actionLabel) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = actionLabel;
      btn.addEventListener("click", function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        clearTimeout(toastTimer);
        t.classList.remove("show");
        t.hidden = true;
        if (actionFn) actionFn();
      });
      t.appendChild(btn);
    }
    t.classList.toggle("has-action", !!actionLabel);
    t.hidden = false;
    // 强制回流以重启动画
    void t.offsetWidth;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (!t.classList.contains("show")) t.hidden = true; }, 200);
    }, actionLabel ? 5200 : 2000);
  }

  /* ---------------- 导出 / 导入 / WebDAV ---------------- */
  function exportBackup() {
    if (!state.notes.length) { toast("没有可导出的笔记"); return; }
    var data = JSON.stringify(state.notes, null, 2);
    var name = "simplenote-zh-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    var fs = plugin("Filesystem");
    var share = plugin("Share");
    if (fs && fs.writeFile && share && share.share) {
      toast("正在准备备份…");
      fs.writeFile({
        path: name,
        data: utf8ToBase64(data),
        directory: "CACHE",
        recursive: true,
      }).then(function (r) {
        return share.share({ title: "简易笔记备份", url: r.uri, dialogTitle: "导出笔记备份" });
      }).catch(function () {
        webDownload(name, data);
        toast("已导出备份");
      });
    } else {
      webDownload(name, data);
      toast("已导出备份");
    }
  }
  function webDownload(name, data) {
    var blob = new Blob([data], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function importAll(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var arr = JSON.parse(reader.result);
        if (Array.isArray(arr)) {
          state.notes = arr.concat(state.notes);
          save();
          renderAll();
          updateImgFixStatus();
          toast("导入成功，共 " + arr.length + " 条笔记");
        } else {
          toast("导入失败：格式不正确");
        }
      } catch (e) {
        toast("导入失败：文件损坏");
      }
    };
    reader.readAsText(file);
  }

  function davConfig() {
    return {
      server: (el.davUrl.value || "").trim().replace(/\/+$/, ""),
      username: (el.davUser.value || "").trim(),
      password: el.davPass.value || "",
      dir: (el.davDir.value || "").trim() || "/easynote",
    };
  }
  function saveDavConfig() {
    state.dav.server = (el.davUrl.value || "").trim();
    state.dav.username = (el.davUser.value || "").trim();
    state.dav.password = el.davPass.value || "";
    state.dav.dir = (el.davDir.value || "").trim() || "/easynote";
    store.setItem(DAV_KEY, JSON.stringify(state.dav));
  }
  // WebDAV 请求：原生平台( Capacitor )走系统原生 HTTP，绕开 WebView 的同源策略(CORS)——
  // WebDAV 服务器基本都不会回 CORS 头，WebView 里直接 fetch 必然被浏览器拦掉，
  // 这正是「电脑端能连、iPhone 连不上」的根因。CapacitorHttp 由 @capacitor/core 内置
  // （无需额外安装插件），在原生端调用即走 NSURLSession，不受 CORS 限制。
  // 浏览器/普通网页环境没有该插件，仍回退 fetch。
  function davFetch(cfg, method, path, body) {
    var headers = {
      Authorization: "Basic " + utf8ToBase64(cfg.username + ":" + cfg.password),
    };
    if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
    var url = cfg.server + path;
    var http = plugin("CapacitorHttp");
    if (http && http.request) {
      var opts = {
        url: url,
        method: method,
        headers: headers,
        connectTimeout: 15000,
        readTimeout: 30000,
      };
      if (body !== undefined && body !== null) opts.data = body;
      return http.request(opts).then(function (r) {
        // 原生返回 { status, headers, data }，包成类 Response 对象供上层统一处理
        return {
          status: r && typeof r.status === "number" ? r.status : 0,
          ok: !!(r && r.status >= 200 && r.status < 300),
          data: r ? r.data : null,
          text: function () { return Promise.resolve(r && r.data != null ? String(r.data) : ""); },
        };
      });
    }
    return fetch(url, { method: method, headers: headers, body: body });
  }
  function testDav() {
    var cfg = davConfig();
    if (!cfg.server) { toast("请先填写 WebDAV 服务器地址"); return; }
    saveDavConfig();
    toast("正在测试连接…");
    davFetch(cfg, "PROPFIND", "/", null)
      .then(function (r) {
        if (r.status >= 200 && r.status < 300) {
          toast("连接成功（目录不存在时导出会自动创建）");
        } else if (r.status === 401 || r.status === 403) {
          toast("连接失败：账号或授权码错误（HTTP " + r.status + "）");
        } else {
          toast("服务器响应异常（HTTP " + r.status + "）");
        }
      })
      .catch(function () {
        toast("连接失败：请检查地址是否可达（需填 https:// 开头），以及账号/授权码是否正确");
      });
  }
  function exportToDav() {
    var cfg = davConfig();
    if (!cfg.server) { toast("请先填写 WebDAV 服务器地址"); return; }
    if (!state.notes.length) { toast("没有可导出的笔记"); return; }
    saveDavConfig();
    toast("正在导出 " + state.notes.length + " 条笔记…");
    var dir = cfg.dir + "/simplenote-zh-" + new Date().toISOString().slice(0, 10);
    davFetch(cfg, "MKCOL", dir, null).catch(function () {})
      .then(function () {
        var backup = JSON.stringify(state.notes.map(serializeNote), null, 2);
        return davFetch(cfg, "PUT", dir + "/backup.json", backup);
      })
      .then(function () {
        var jobs = state.notes.map(function (n) {
          var fname = dir + "/" + safeFileName(n) + ".md";
          return davFetch(cfg, "PUT", fname, n.content || "").catch(function () { return null; });
        });
        return Promise.all(jobs);
      })
      .then(function () {
        toast("导出完成：" + state.notes.length + " 条 → " + dir);
      })
      .catch(function () {
        toast("导出失败：请检查地址是否可达（需填 https:// 开头），以及账号/授权码是否正确");
      });
  }
  function safeFileName(n) {
    var t = getTitle(n).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    return (t || "无标题") + "-" + n.id.slice(-6);
  }

  /* ---------------- 插入文本 / 图片 / 链接 ---------------- */
  function currentNote() {
    return state.notes.filter(function (n) { return n.id === state.currentId; })[0] || null;
  }
  function insertAtCursor(ta, text) {
    var start = ta.selectionStart, end = ta.selectionEnd;
    var val = ta.value;
    ta.value = val.slice(0, start) + text + val.slice(end);
    var pos = start + text.length;
    ta.selectionStart = ta.selectionEnd = pos;
  }
  function triggerInput(ta) {
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  }
  function insertChecklist() {
    var ta = el.editor;
    var note = currentNote();
    if (!note || note.deleted) return;
    var start = ta.selectionStart, end = ta.selectionEnd;
    var text = ta.value;
    var before = text.slice(0, start);
    var sel = text.slice(start, end);
    var prefix = (before === "" || /[\n]$/.test(before)) ? "- [ ] " : "\n- [ ] ";
    var insert = prefix + sel;
    ta.value = text.slice(0, start) + insert + text.slice(end);
    var pos = start + insert.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  }
  function formatDateTime(d) {
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function insertTextElement(type) {
    var note = currentNote();
    if (!note || note.deleted) return;
    var snippet;
    if (type === "quote") snippet = "\n> 引用内容\n";
    else if (type === "code") snippet = "\n```\n代码\n```\n";
    else if (type === "hr") snippet = "\n---\n";
    else if (type === "datetime") snippet = formatDateTime(new Date());
    else snippet = "";
    if (!snippet) return;
    insertAtCursor(el.editor, snippet);
    triggerInput(el.editor);
  }

  // 图片插入：拍照 / 相册 → 压缩（最长边 ≤1600px）→ 内嵌 data URI
  var IMG_MAX = 1600;
  function openImageSourceSheet() {
    var note = currentNote();
    if (!note || note.deleted) return;
    var camera = plugin("Camera");
    if (!camera || !camera.getPhoto) { toast("当前环境不支持选择图片"); return; }
    showSheet("插入图片", [
      {
        label: "📷 拍照",
        action: function () { pickImage("camera"); },
      },
      {
        label: "🖼 从相册选择",
        action: function () { pickImage("photos"); },
      },
    ]);
  }
  function pickImage(source) {
    var camera = plugin("Camera");
    var note = currentNote();
    if (!note || note.deleted) return;
    camera.getPhoto({
      quality: 90,
      resultType: "dataUrl",
      source: source, // "camera" | "photos"
      width: 2000,
      correctOrientation: true,
    }).then(function (photo) {
      if (!photo || !photo.dataUrl) { toast("插入图片失败"); return; }
      return resizeDataUrl(photo.dataUrl, IMG_MAX);
    }).then(function (dataUrl) {
      if (!dataUrl) return;
      // 智能排版：图片单独占一行，光标落在图片下方，便于接着打字
      var ta = el.editor;
      var start = ta.selectionStart, end = ta.selectionEnd;
      var before = ta.value.slice(0, start);
      var md = (start > 0 && !/\n$/.test(before) ? "\n" : "") + "![" + formatDateTime(new Date()) + "](" + dataUrl + ")\n";
      var caret = start + md.length;
      ta.value = before + md + ta.value.slice(end);
      triggerInput(ta);
      if (!note.markdown) note.markdown = true;
      state.preview = true; // 插图后直接打开预览，立刻能看到图
      save();
      renderAll();
      try {
        el.editor.focus();
        var len = el.editor.value.length;
        el.editor.selectionStart = el.editor.selectionEnd = Math.min(caret, len);
      } catch (e) {}
      toast("已插入图片（已内嵌压缩）");
    }).catch(function () {
      toast("插入图片失败或已取消");
    });
  }
  // canvas 压缩：最长边限制在 max 像素内，保持比例；小图原样返回
  function resizeDataUrl(dataUrl, max) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      // 安全网：个别 WebView 上 onload 可能不触发，5 秒后原样返回，绝不卡住插入流程
      setTimeout(function () { finish(dataUrl); }, 5000);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          var scale = Math.min(1, max / Math.max(w, h));
          if (scale >= 1) { finish(dataUrl); return; }
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          var ctx = canvas.getContext && canvas.getContext("2d");
          if (!ctx) { finish(dataUrl); return; } // 无 canvas 环境：原样返回
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL("image/jpeg", 0.85));
        } catch (e) {
          finish(dataUrl);
        }
      };
      img.onerror = function () { finish(dataUrl); };
      img.src = dataUrl;
    });
  }

  function insertLink() {
    var note = currentNote();
    if (!note || note.deleted) return;
    var ta = el.editor;
    var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    el._linkSel = sel;
    el.linkUrl.value = "https://";
    el.linkText.value = sel || "";
    el.linkModal.hidden = false;
    setTimeout(function () { el.linkUrl.focus(); el.linkUrl.select(); }, 30);
  }
  function confirmLink() {
    var url = (el.linkUrl.value || "").trim();
    if (!url) { toast("链接地址不能为空"); el.linkUrl.focus(); return; }
    var text = (el.linkText.value || "").trim() || url;
    var ta = el.editor;
    var md = "[" + text + "](" + url + ")";
    if (el._linkSel) {
      var start = ta.selectionStart, end = ta.selectionEnd, val = ta.value;
      ta.value = val.slice(0, start) + md + val.slice(end);
      ta.selectionStart = ta.selectionEnd = start + md.length;
    } else {
      insertAtCursor(ta, md);
    }
    triggerInput(ta);
    el.linkModal.hidden = true;
    var note = currentNote();
    if (note && !note.markdown) { note.markdown = true; save(); renderAll(); }
    toast("已插入链接（点 👁 预览 / 点击可打开）");
  }
  function closeLinkModal() {
    el.linkModal.hidden = true;
  }

  /* ---------------- 云同步 / 账号（与桌面端同协议） ---------------- */
  function normalizeServerUrl(u) {
    u = (u || "").trim().replace(/\/+$/, "");
    if (!u) return "http://localhost:3000";
    if (!/^https?:\/\//i.test(u)) u = "http://" + u;
    return u;
  }
  function getServerUrl() {
    return normalizeServerUrl(state.serverUrl);
  }
  function authHeaders() {
    var h = { "Content-Type": "application/json" };
    if (state.token) h["Authorization"] = "Bearer " + state.token;
    return h;
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = authHeaders();
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    }
    var url = getServerUrl() + path;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 60000) : null;
    return fetch(url, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
      signal: controller ? controller.signal : undefined,
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (r.status === 413) {
          throw new Error("笔记内容过大，服务器拒绝接收（413）。请减少内嵌图片，或调大服务端请求体限制");
        }
        if (!r.ok) throw new Error((data && data.error) ? data.error : "服务器返回错误 (" + r.status + ")");
        return data || {};
      });
    }).catch(function (e) {
      if (e && e.name === "AbortError") {
        throw new Error("连接服务器超时（60 秒无响应）。请检查服务端是否正常、网络是否稳定");
      }
      if (e && e.message && /failed to fetch|load failed|networkerror/i.test(e.message)) {
        throw new Error("无法连接服务器 " + url + "。请检查：① 地址是否填对（填 IP:端口 即可，会自动补 http://）② 服务端是否已启动 ③ 手机与服务端是否在同一局域网");
      }
      throw e;
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }
  function serializeNote(n) {
    return {
      id: n.id,
      content: n.content || "",
      pinned: !!n.pinned,
      markdown: !!n.markdown,
      deleted: !!n.deleted,
      color: n.color || "",
      createdDate: n.createdDate || Date.now(),
      modifiedDate: n.modifiedDate || Date.now(),
      deletedDate: n.deletedDate || null,
      storedAt: n.storedAt,
    };
  }
  function setSyncStatus(txt, cls) {
    if (el.syncPill) {
      el.syncPill.textContent = txt;
      el.syncPill.className = "sync-pill" + (cls ? " " + cls : "");
    }
    if (el.syncStatus) el.syncStatus.textContent = txt;
  }
  function updateAccountUI() {
    if (state.token && state.user) {
      if (el.accLoggedIn) el.accLoggedIn.hidden = false;
      if (el.accLoggedOut) el.accLoggedOut.hidden = true;
      if (el.accName) el.accName.textContent = state.user;
      setSyncStatus("就绪", "ok");
    } else {
      if (el.accLoggedIn) el.accLoggedIn.hidden = true;
      if (el.accLoggedOut) el.accLoggedOut.hidden = false;
      setSyncStatus("未登录");
    }
  }
  function doAuth(isRegister) {
    var u = (el.accUser.value || "").trim();
    var p = el.accPass.value || "";
    var server = normalizeServerUrl((el.serverUrl.value || "").trim());
    if (!u || !p) { toast("请输入用户名和密码"); return; }
    el.serverUrl.value = server;
    state.serverUrl = server;
    store.setItem(SERVER_KEY, server);
    setSyncStatus(isRegister ? "注册中…" : "登录中…", "busy");
    api(isRegister ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ username: u, password: p }),
    }).then(function (res) {
      state.token = res.token;
      state.user = res.username;
      store.setItem(TOKEN_KEY, res.token);
      store.setItem(USER_KEY, res.username);
      updateAccountUI();
      resetSyncCursors();
      startPeriodicSync();
      return syncAll();
    }).then(function () {
      toast(isRegister ? "注册成功，已同步" : "登录成功，已同步");
      el.accPass.value = "";
    }).catch(function (e) {
      setSyncStatus("错误：" + e.message, "err");
      toast("失败：" + e.message);
    });
  }
  function logout() {
    state.token = "";
    state.user = "";
    store.removeItem(TOKEN_KEY);
    store.removeItem(USER_KEY);
    stopPeriodicSync();
    resetSyncCursors();
    updateAccountUI();
    renderAll();
    toast("已退出登录");
  }
  function testConnection() {
    var server = normalizeServerUrl((el.serverUrl.value || "").trim());
    el.serverUrl.value = server;
    setSyncStatus("正在测试连接 " + server + " …", "busy");
    fetch(server + "/api/health")
      .then(function (r) {
        if (r.ok) {
          setSyncStatus("连接成功：" + server, "ok");
          toast("连接成功：" + server);
        } else {
          setSyncStatus("服务器有响应，但状态异常（HTTP " + r.status + "）", "err");
          toast("连接异常：HTTP " + r.status);
        }
      })
      .catch(function () {
        setSyncStatus("连接失败：" + server, "err");
        toast("连接失败：" + server + "，请检查地址、服务端与网络");
      });
  }
  var syncTimer;
  var periodicSyncTimer = null;
  var SYNC_INTERVAL_MS = 3000;
  var SYNC_DEBOUNCE_MS = 800;
  function scheduleSync() {
    if (!state.token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncAll, SYNC_DEBOUNCE_MS);
  }
  var pendingConflictCount = 0; // 本轮同步产生了多少条冲突副本（用于提示用户）
  // 双端同时修改同一篇笔记时，把"本机尚未同步成功的版本"另存为一条独立笔记
  // （冲突副本），避免被服务端版本直接覆盖导致改动静默丢失。
  function makeConflictCopy(loc) {
    var now = Date.now();
    var title = "无标题";
    var lines = (loc.content || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { title = lines[i].trim().slice(0, 30); break; }
    }
    return {
      id: uid(),
      content:
        "⚠ 冲突副本（本机版本 · 另一台设备也修改过这条笔记）\n" +
        "原笔记标题：" + title + "\n" +
        "生成时间：" + new Date(now).toLocaleString("zh-CN") + "\n\n" +
        (loc.content || ""),
      pinned: false, markdown: !!loc.markdown, deleted: false,
      color: loc.color || "",
      createdDate: loc.createdDate || now,
      modifiedDate: now,
    };
  }
  function mergeNotes(incoming) {
    var byId = {};
    state.notes.forEach(function (n) { if (n && n.id) byId[n.id] = n; });
    var changed = false;
    var conflicts = [];
    (incoming || []).forEach(function (n) {
      if (!n || !isValidNoteId(n.id)) return;
      var loc = byId[n.id];
      if (!loc) { byId[n.id] = n; changed = true; return; }
      if ((n.modifiedDate || 0) > (loc.modifiedDate || 0)) {
        // 本地有"还没推送成功"的改动，且服务端版本内容不同 → 先留一份冲突副本再覆盖
        var pushedAt = (state.pushed && state.pushed[n.id]) || 0;
        var localDirty = (loc.modifiedDate || 0) > pushedAt;
        if (localDirty && (loc.content || "") !== (n.content || "")) conflicts.push(makeConflictCopy(loc));
        byId[n.id] = n; changed = true;
      }
    });
    if (conflicts.length) {
      conflicts.forEach(function (c) { byId[c.id] = c; });
      pendingConflictCount += conflicts.length;
      changed = true;
    }
    state.notes = Object.keys(byId).map(function (k) { return byId[k]; });
    return changed;
  }
  function notesToPush() {
    return state.notes.filter(function (n) {
      var p = state.pushed[n.id];
      return !p || (n.modifiedDate || 0) > p;
    });
  }
  function markPushedAfterRound(pushedPayload, confirmed) {
    var next = {};
    state.notes.forEach(function (n) {
      if (!n || !n.id) return;
      var payloadTs = pushedPayload[n.id];
      if (confirmed && confirmed[n.id] !== undefined) {
        next[n.id] = confirmed[n.id];
      } else if (payloadTs !== undefined && (n.modifiedDate || 0) <= payloadTs) {
        next[n.id] = payloadTs;
      } else {
        next[n.id] = state.pushed[n.id] || 0;
      }
    });
    state.pushed = next;
    store.setItem(PUSHED_KEY, JSON.stringify(next));
  }
  function applySyncResponse(res) {
    var changed = false;
    var confirmed = {};
    if (res && res.notes) {
      (res.notes || []).forEach(function (n) { if (n && n.id) confirmed[n.id] = n.modifiedDate || 0; });
      changed = mergeNotes(res.notes);
      if (changed) filterPurged();
    }
    // 跨端墓碑：其他设备永久删除的笔记，本地也清掉，保持回收站一致
    if (res && res.removed && res.removed.length) {
      var removedSet = {};
      res.removed.forEach(function (id) { if (!isValidNoteId(id)) return; removedSet[id] = true; if (state.purged.indexOf(id) === -1) state.purged.push(id); });
      store.setItem(PURGE_KEY, JSON.stringify(state.purged));
      var before = state.notes.length;
      state.notes = state.notes.filter(function (n) { return !removedSet[n.id]; });
      if (state.notes.length !== before) { changed = true; saveLocalOnly(); }
    }
    if (res && typeof res.serverTime === "number" && res.serverTime > 0) {
      state.since = res.serverTime;
      store.setItem(SINCE_KEY, String(state.since));
      if (state.legacyServer) { state.legacyServer = false; startPeriodicSync(); }
    } else {
      if (!state.legacyServer) { state.legacyServer = true; startPeriodicSync(); }
    }
    if (res && typeof res.total === "number") {
      if (state.serverTotal > 0 && res.total < state.serverTotal) {
        state.since = 0; store.setItem(SINCE_KEY, "0");
        state.pushed = {}; store.setItem(PUSHED_KEY, "{}");
        state.serverTotal = res.total; store.setItem(TOTAL_KEY, String(res.total));
        return { shrink: true, changed: changed, confirmed: confirmed };
      }
      state.serverTotal = res.total;
      store.setItem(TOTAL_KEY, String(res.total));
    }
    return { shrink: false, changed: changed, confirmed: confirmed };
  }
  function startPeriodicSync() {
    stopPeriodicSync();
    if (!state.token) return;
    periodicSyncTimer = setInterval(function () {
      if (!state.token || syncInFlight) return;
      syncAll();
    }, state.legacyServer ? SYNC_INTERVAL_MS * 10 : SYNC_INTERVAL_MS);
  }
  function stopPeriodicSync() {
    if (periodicSyncTimer) { clearInterval(periodicSyncTimer); periodicSyncTimer = null; }
  }
  function syncAll() {
    if (!state.token) return Promise.resolve();
    if (syncInFlight) return Promise.resolve();
    syncInFlight = true;
    var pending = notesToPush().map(serializeNote);
    var pushedPayload = {};
    pending.forEach(function (n) { pushedPayload[n.id] = n.modifiedDate || 0; });
    if (pending.length) setSyncStatus("同步中…", "busy");
    return api("/api/notes/sync", {
      method: "POST",
      body: JSON.stringify({ notes: pending, since: state.since || 0 }),
    })
      .then(function (res) {
        var r = applySyncResponse(res);
        if (!r.shrink) {
          if (r.changed) { saveLocalOnly(); renderAll(); }
          if (pendingConflictCount > 0) {
            // 双端同时改同一篇：已保底为冲突副本，明确提示用户，避免以为"改动丢了"
            toast("检测到 " + pendingConflictCount + " 条笔记在多端同时修改，已保留为「冲突副本」，请查看");
            pendingConflictCount = 0;
          }
          if (pending.length || r.changed) {
            markPushedAfterRound(pushedPayload, r.confirmed);
            updateImgFixStatus();
          }
          state.lastSyncTs = Date.now();
          setSyncStatus("已同步 · " + new Date().toLocaleTimeString("zh-CN"), "ok");
        }
        return r.shrink;
      })
      .catch(function (e) {
        setSyncStatus("同步失败：" + e.message, "err");
        return false;
      })
      .then(function (shrink) {
        syncInFlight = false;
        if (shrink) recoverFromShrink();
      });
  }
  function recoverFromShrink() {
    pullOnly(true).then(function () { syncAll(); });
  }
  function pullOnly(forceFull) {
    var since = forceFull ? 0 : (state.since || 0);
    return api("/api/notes?since=" + since, { method: "GET" }).then(function (res) {
      var r = applySyncResponse(res);
      if (!r.shrink && r.changed) markPushedAfterRound({}, r.confirmed);
      if (r.shrink) recoverFromShrink();
      return res;
    });
  }
  function resetSyncCursors() {
    state.since = 0;
    state.pushed = {};
    state.serverTotal = 0;
    state.legacyServer = false;
    store.setItem(SINCE_KEY, "0");
    store.setItem(PUSHED_KEY, "{}");
    store.setItem(TOTAL_KEY, "0");
  }
  // 把永久删除上报到服务端（记入墓碑），让其他设备也清掉
  function purgeOnServer(ids) {
    if (!state.token || !ids || !ids.length) return;
    api("/api/notes/purge", { method: "POST", body: JSON.stringify({ ids: ids }) })
      .catch(function () { /* 失败不阻塞本地删除，下次同步也会纠正 */ });
  }

  /* ---------------- 外链图片检测（手机上只提示，修复需在电脑端） ---------------- */
  var EXTERNAL_IMG_RE = /!\[[^\]]*\]\((?:file|easynote-file):\/\/[^)\s]+\)/g;
  function collectExternalImages() {
    var paths = {};
    var noteCount = 0, refCount = 0;
    state.notes.forEach(function (n) {
      if (!n || n.deleted) return;
      var c = n.content || "";
      var m, has = false;
      EXTERNAL_IMG_RE.lastIndex = 0;
      while ((m = EXTERNAL_IMG_RE.exec(c)) !== null) {
        has = true; refCount++;
      }
      if (has) noteCount++;
    });
    return { noteCount: noteCount, refCount: refCount };
  }
  function updateImgFixStatus() {
    var found = collectExternalImages();
    if (el.imgFixStatus) {
      el.imgFixStatus.textContent = found.refCount
        ? "检测到 " + found.noteCount + " 条笔记中有 " + found.refCount + " 处外链图片（这些图片保存在电脑本地，手机读不到）。请在电脑端打开简易笔记，设置里点「一键修复」并同步，手机即可显示。"
        : "未检测到外链图片：当前笔记里的图片都已内嵌保存（或暂无图片）。";
    }
    if (el.imgFixBanner) {
      if (found.refCount) {
        if (el.imgFixText) {
          el.imgFixText.textContent = "有 " + found.refCount + " 处图片保存在电脑本地，手机暂不显示";
        }
        el.imgFixBanner.hidden = false;
      } else {
        el.imgFixBanner.hidden = true;
      }
    }
    if (el.btnEmbedImages) el.btnEmbedImages.hidden = true;
  }

  /* ---------------- 设置界面 ---------------- */
  var SYSTEM_FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", ' +
    '"Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans CN", sans-serif';
  // 把字体值（单个字体名 / 逗号分隔的字体栈）组装成合法的 CSS font-family 列表：
  // 含空格的字体名自动加引号，已带引号则保持；最后追加系统字体栈兜底。
  function tellFamily(f) {
    f = (f || "").trim();
    if (!f) return "";
    if (/^["'].*["']$/.test(f)) return f;        // 已带引号，原样保留
    if (/[\s]/.test(f)) return '"' + f + '"';    // 含空格 → 加引号
    return f;
  }
  function buildFontStack(value) {
    if (!value) return SYSTEM_FONT_STACK;
    var parts = String(value).split(",").map(tellFamily).filter(function (t) { return t; });
    parts.push(SYSTEM_FONT_STACK);
    return parts.join(", ");
  }
  function applySettings() {
    document.documentElement.style.setProperty("--font", buildFontStack(state.fontFamily));
    document.documentElement.style.setProperty("--editor-fs", (state.fontSize || 16) + "px");
  }
  function refreshSettingsUI() {
    if (el.themeModeSelect) el.themeModeSelect.value = state.themeMode;
    if (el.trashDaysSelect) el.trashDaysSelect.value = String(state.trashAutoDays || 0);
    if (el.fontSizeSelect) el.fontSizeSelect.value = String(state.fontSize || 16);
    if (el.fontSelect) el.fontSelect.value = state.fontFamily || "";
    if (el.fontCustom) el.fontCustom.value = state.fontFamily || "";
    if (el.serverUrl) el.serverUrl.value = normalizeServerUrl(state.serverUrl);
    if (el.davUrl) el.davUrl.value = state.dav.server || "";
    if (el.davUser) el.davUser.value = state.dav.username || "";
    if (el.davPass) el.davPass.value = state.dav.password || "";
    if (el.davDir) el.davDir.value = state.dav.dir || "/easynote";
    updateAccountUI();
    updateImgFixStatus();
  }
  function applyCustomFont() {
    var v = (el.fontCustom.value || "").trim();
    if (!v) return;
    state.fontFamily = v;
    store.setItem(FONT_KEY, v);
    if (el.fontSelect) el.fontSelect.value = v;
    applySettings();
    toast("已应用字体：" + v);
  }

  /* ---------------- 更新检查（只认 mobile-v 开头的移动端版本） ---------------- */
  var REPO = "feibixunchang/easynote";
  var MOBILE_TAG_RE = /^mobile-v(\d+(?:\.\d+){1,2})$/;
  function fetchWithTimeout(url, ms) {
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, ms || 12000) : null;
    return fetch(url, { signal: controller ? controller.signal : undefined }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }
  function pickMobileVersion(tags) {
    var best = null;
    (tags || []).forEach(function (t) {
      var m = MOBILE_TAG_RE.exec(String(t || ""));
      if (!m) return;
      if (!best || compareVersions(m[1], best) > 0) best = m[1];
    });
    return best;
  }
  function fetchLatestMobileVersion() {
    // ① GitHub API releases 列表，过滤 mobile-v* 标签
    return fetchWithTimeout("https://api.github.com/repos/" + REPO + "/releases?per_page=20")
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (list) {
        if (!Array.isArray(list)) throw new Error("bad data");
        var v = pickMobileVersion(list.map(function (x) { return x && x.tag_name; }));
        if (v) return { version: v, url: "https://github.com/" + REPO + "/releases/tag/mobile-v" + v };
        throw new Error("no mobile release");
      })
      .catch(function () {
        // ② atom 源兜底
        return fetchWithTimeout("https://github.com/" + REPO + "/releases.atom")
          .then(function (r) {
            if (!r.ok) throw new Error("http " + r.status);
            return r.text();
          })
          .then(function (xml) {
            var re = /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g;
            var tags = [];
            var m;
            while ((m = re.exec(xml)) !== null) tags.push(m[1]);
            var v = pickMobileVersion(tags);
            if (v) return { version: v, url: "https://github.com/" + REPO + "/releases/tag/mobile-v" + v };
            return null;
          })
          .catch(function () { return null; });
      });
  }
  function compareVersions(a, b) {
    var pa = String(a).split(".").map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b).split(".").map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  function openUrl(url) {
    var browser = plugin("Browser");
    if (browser && browser.open) {
      browser.open({ url: url }).catch(function () { window.open(url, "_blank"); });
    } else if (url) {
      window.open(url, "_blank");
    }
  }
  var updateUrl = "";
  function showUpdateBanner(version, url) {
    updateUrl = url || "";
    if (el.updateText) el.updateText.textContent = "发现新版本 v" + version + "，前往下载";
    if (el.updateDownloadBtn) {
      el.updateDownloadBtn.hidden = false;
      el.updateDownloadBtn.onclick = function () { openUrl(updateUrl); };
    }
    if (el.updateBanner) el.updateBanner.hidden = false;
  }
  function hideUpdateBanner() {
    if (el.updateBanner) el.updateBanner.hidden = true;
  }
  function checkMobileUpdate(manual) {
    if (el.appVersion) el.appVersion.textContent = "检查中…";
    fetchLatestMobileVersion().then(function (info) {
      if (el.appVersion) el.appVersion.textContent = "v" + APP_VERSION;
      if (info && info.version && compareVersions(info.version, APP_VERSION) > 0) {
        showUpdateBanner(info.version, info.url);
        toast("发现新版本 v" + info.version);
      } else if (manual) {
        toast("✓ 已是最新版本 v" + APP_VERSION);
      }
    }).catch(function () {
      if (el.appVersion) el.appVersion.textContent = "v" + APP_VERSION;
      if (manual) toast("检查更新失败：网络不可达");
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    el.newBtn.addEventListener("click", createNote);
    // 列表一滚就把滑开的那行收回去，否则滚动时半开的卡片很碍眼
    el.noteList.addEventListener("scroll", closeOpenSwipe, { passive: true });
    el.btnBack.addEventListener("click", goList);
    el.btnSettingsBack.addEventListener("click", goList);
    el.btnTheme.addEventListener("click", function () {
      setThemeMode(state.dark ? "light" : "dark");
    });
    el.btnListMenu.addEventListener("click", openListMenuSheet);
    el.btnEditorMore.addEventListener("click", openEditorMoreSheet);
    el.btnSort.addEventListener("click", openSortSheet);
    el.syncPill.addEventListener("click", goSettings);

    el.btnSearch.addEventListener("click", function () {
      el.searchRow.hidden = false;
      el.search.focus();
    });
    el.btnSearchClose.addEventListener("click", function () {
      el.searchRow.hidden = true;
      el.search.value = "";
      state.query = "";
      renderAll();
    });
    el.search.addEventListener("input", function () {
      state.query = el.search.value;
      renderList();
    });

    el.appVersion.addEventListener("click", function () { checkMobileUpdate(true); });

    if (el.btnDrawer) el.btnDrawer.addEventListener("click", openDrawer);
    if (el.drawerMask) el.drawerMask.addEventListener("click", closeDrawer);
    if (el.drawer) {
      var drawerBtns = el.drawer.querySelectorAll(".drawer-item");
      for (var d = 0; d < drawerBtns.length; d++) {
        (function (btn) {
          btn.addEventListener("click", function () {
            var v = btn.getAttribute("data-view");
            closeDrawer();
            if (v === "settings") { goSettings(); return; }
            state.view = v === "trash" ? "trash" : "notes";
            state.activeTag = null;
            if (document.body.getAttribute("data-screen") === "settings") setScreen("list");
            refreshListView();
          });
        })(drawerBtns[d]);
      }
    }
    // 从左边缘右滑也能拉出抽屉（与 Simplenote 一致）
    (function () {
      var startX = 0, startY = 0, tracking = false;
      document.addEventListener("touchstart", function (e) {
        if (!e.touches || !e.touches[0]) return;
        var t = e.touches[0];
        if (t.clientX <= 28) { tracking = true; startX = t.clientX; startY = t.clientY; }
      }, { passive: true });
      document.addEventListener("touchend", function (e) {
        if (!tracking) return;
        tracking = false;
        var t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        if (t.clientX - startX > 45 && Math.abs(t.clientY - startY) < 40) openDrawer();
      }, { passive: true });
    })();

    if (el.trashDaysSelect) {
      el.trashDaysSelect.addEventListener("change", function () {
        state.trashAutoDays = parseInt(el.trashDaysSelect.value, 10) || 0;
        store.setItem(TRASHDAYS_KEY, String(state.trashAutoDays));
        toast(state.trashAutoDays ? "回收站将自动清理超过 " + state.trashAutoDays + " 天的笔记" : "已关闭回收站自动清理");
      });
    }

    // 回收站批量操作
    if (el.trashAll) {
      el.trashAll.addEventListener("change", function () {
        var list = getNotes();
        state.selected = {};
        if (el.trashAll.checked) list.forEach(function (n) { state.selected[n.id] = true; });
        renderList();
      });
    }
    if (el.trashRestoreSel) el.trashRestoreSel.addEventListener("click", restoreSelected);
    if (el.trashPurgeSel) el.trashPurgeSel.addEventListener("click", purgeSelected);

    // 清空回收站（本地 + 上报服务端，跨端一致）
    if (el.btnEmptyTrash) {
      el.btnEmptyTrash.addEventListener("click", function () {
        var trashed = getNotes();
        if (!trashed.length) return;
        openConfirm("清空回收站", "将永久删除回收站里的 " + trashed.length + " 条笔记（不可恢复），并同步到所有设备？", function () {
          var ids = trashed.map(function (n) { return n.id; });
          ids.forEach(function (id) { if (state.purged.indexOf(id) === -1) state.purged.push(id); });
          store.setItem(PURGE_KEY, JSON.stringify(state.purged));
          state.notes = state.notes.filter(function (n) { return state.purged.indexOf(n.id) === -1; });
          state.currentId = null;
          purgeOnServer(ids);
          save(); renderAll();
          toast("已清空回收站");
        });
      });
    }

    // 编辑器输入：自动保存 + 防抖刷新列表 + 标题/保存提示
      var debounce;
      var previewDebounce;
      var saveFlagTimer;
      el.editor.addEventListener("input", function () {
      var note = currentNote();
      if (!note || note.deleted) return;
      note.content = el.editor.value;
      note.modifiedDate = Date.now();
      el.editorTitle.textContent = getTitle(note);
      // 内存即时更新，落盘防抖（带图笔记动辄几 MB，逐字写盘会卡死输入）
      scheduleEditorSave();
      clearTimeout(debounce);
      debounce = setTimeout(function () { renderList(); renderTags(); }, 250);
      // 开着预览时同步刷新渲染结果（图片笔记体积大，用更长的防抖）
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(function () {
        if (!el.previewPane.hidden) el.previewPane.innerHTML = renderMarkdown(el.editor.value);
      }, 700);
    });

    // 预览区点击链接 → 系统浏览器
    el.previewPane.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[data-mdlink]") : null;
      if (a) {
        e.preventDefault();
        var href = a.getAttribute("href");
        if (href) openUrl(href);
      }
    });

    // 弹窗
    el.linkConfirm.addEventListener("click", confirmLink);
    el.linkCancel.addEventListener("click", closeLinkModal);
    el.linkModal.addEventListener("click", function (e) {
      if (e.target === el.linkModal) closeLinkModal();
    });
    el.infoClose.addEventListener("click", function () { el.infoModal.hidden = true; });
    el.infoModal.addEventListener("click", function (e) {
      if (e.target === el.infoModal) el.infoModal.hidden = true;
    });
    el.linkUrl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); confirmLink(); }
    });
    el.linkText.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); confirmLink(); }
    });

    // 底部面板
    el.sheetMask.addEventListener("click", hideSheet);
    el.sheetCancel.addEventListener("click", hideSheet);

    // 横幅
    if (el.updateDismissBtn) el.updateDismissBtn.addEventListener("click", hideUpdateBanner);
    if (el.imgFixDismissBtn) el.imgFixDismissBtn.addEventListener("click", function () {
      el.imgFixBanner.hidden = true;
    });

    // 账号
    el.btnLogin.addEventListener("click", function () { doAuth(false); });
    el.btnRegister.addEventListener("click", function () { doAuth(true); });
    el.btnTestConn.addEventListener("click", testConnection);
    el.btnSync.addEventListener("click", function () { syncAll(); });
    el.btnLogout.addEventListener("click", logout);

    // 设置
    el.themeModeSelect.addEventListener("change", function () {
      setThemeMode(el.themeModeSelect.value);
      toast("主题已切换");
    });
    el.fontSizeSelect.addEventListener("change", function () {
      state.fontSize = parseInt(el.fontSizeSelect.value, 10) || 16;
      store.setItem(FONTSIZE_KEY, String(state.fontSize));
      applySettings();
    });
    el.fontSelect.addEventListener("change", function () {
      state.fontFamily = el.fontSelect.value;
      store.setItem(FONT_KEY, state.fontFamily);
      applySettings();
    });
    el.fontCustomApply.addEventListener("click", applyCustomFont);
    el.fontCustom.addEventListener("keydown", function (e) {
      if (e.key === "Enter") applyCustomFont();
    });

    // 数据
    el.btnExport.addEventListener("click", exportBackup);
    el.btnImport.addEventListener("click", function () { el.importFile.click(); });
    el.importFile.addEventListener("change", function (e) {
      var f = e.target.files[0];
      if (f) importAll(f);
      e.target.value = "";
    });
    el.btnDavTest.addEventListener("click", testDav);
    el.btnDavExport.addEventListener("click", exportToDav);
    el.btnCheckUpdate.addEventListener("click", function () { checkMobileUpdate(true); });

    // 系统主题变化
    if (window.matchMedia) {
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
          if (state.themeMode === "auto") {
            applyTheme();
            renderAll();
          }
        });
      } catch (e) {}
    }

    // 硬件返回键（Android）：面板 → 弹窗 → 编辑器 → 设置 → 列表
    var appPlugin = plugin("App");
    if (appPlugin && appPlugin.addListener) {
      appPlugin.addListener("backButton", function () {
        if (!el.actionSheet.hidden) { hideSheet(); return; }
        if (!el.linkModal.hidden) { closeLinkModal(); return; }
        if (!el.infoModal.hidden) { el.infoModal.hidden = true; return; }
        var screen = document.body.getAttribute("data-screen");
        if (screen === "editor") { goList(); return; }
        if (screen === "settings") { goList(); return; }
        if (appPlugin.exitApp) appPlugin.exitApp();
      });
    }

    // 切回前台立即同步（移动端常在后台被挂起）
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { flushEditorSave(); return; }  // 进后台先把改动落盘
      if (state.token) syncAll();
    });
    // 页面被销毁 / 切走时兜底落盘
    window.addEventListener("pagehide", flushEditorSave);
    window.addEventListener("beforeunload", flushEditorSave);
  }

  /* ---------------- 初始化 ---------------- */
  function seedIfEmpty() {
    if (state.notes.length === 0) {
      var now = Date.now();
      state.notes.push({
        id: uid(),
        content:
          "欢迎使用简易笔记\n\n这是一个高度还原 Simplenote 的纯中文笔记软件，支持账号云同步与多端使用。\n\n# 功能一览\n- 界面随手机 / 平板屏幕大小自适应\n- 搜索、标签（用 #标签 语法）、置顶、颜色\n- Markdown 编辑与实时预览\n- 插入图片（拍照 / 相册，自动压缩内嵌）、插入链接、插入文本元素\n- 回收站、深色模式、导入导出、WebDAV 导出\n- 长按笔记有操作菜单；登录后每 3 秒自动同步，电脑上改完手机上随即显示\n\n**加粗**、*斜体*、`行内代码` 都支持。\n点击工具栏 M↓ 开启 Markdown，再点 👁 预览。",
        pinned: true,
        markdown: true,
        deleted: false,
        createdDate: now,
        modifiedDate: now,
      });
      save();
    }
  }

  function init() {
    cacheDom();
    load();
    filterPurged();
    var autoPurged = autoPurgeTrash(); // 回收站自动清理（默认关闭）
    applySettings();
    bindEvents();
    updateAccountUI();
    renderAll();
    if (el.appVersion) el.appVersion.textContent = "v" + APP_VERSION;
    if (el.aboutVersion) el.aboutVersion.textContent = "v" + APP_VERSION;

    // 原生版本号（与 package.json 一致，cap sync 会写进各平台工程）
    var appPlugin = plugin("App");
    if (appPlugin && appPlugin.getInfo) {
      appPlugin.getInfo().then(function (info) {
        if (info && info.version) {
          APP_VERSION = info.version;
          if (el.appVersion) el.appVersion.textContent = "v" + APP_VERSION;
          if (el.aboutVersion) el.aboutVersion.textContent = "v" + APP_VERSION;
        }
      }).catch(function () {});
    }

    if (state.token) {
      syncAll().then(function () {
        if (state.notes.length === 0) { seedIfEmpty(); saveLocalOnly(); renderAll(); }
      });
      startPeriodicSync();
    } else {
      seedIfEmpty();
      renderAll();
    }

    // 延迟检测外链图片 + 检查更新（不阻塞首屏）
    setTimeout(updateImgFixStatus, 800);
    setTimeout(function () { checkMobileUpdate(false); }, 5000);

    // 隐藏启动图
    var splash = plugin("SplashScreen");
    if (splash && splash.hide) splash.hide();

    if (autoPurged > 0) {
      setTimeout(function () {
        toast("回收站已自动清理 " + autoPurged + " 条超过 " + state.trashAutoDays + " 天的笔记");
      }, 1500);
    }

    // 供测试钩子
    window.__app = { state: state, renderAll: renderAll, syncAll: syncAll, api: api, autoPurgeTrash: autoPurgeTrash };
  }

  init();
})();
