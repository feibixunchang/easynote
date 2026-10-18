/* ============ 简易笔记 · 核心逻辑 ============ */
(function () {
  "use strict";

  var STORE_KEY = "simplenote_zh_v1";
  var DARK_KEY = "simplenote_zh_dark";
  var THEME_KEY = "simplenote_zh_theme"; // auto | light | dark
  var FONT_KEY = "simplenote_zh_font";
  var FONTSIZE_KEY = "simplenote_zh_fontsize";
  var SERVER_KEY = "simplenote_zh_server";
  var TOKEN_KEY = "simplenote_zh_token";
  var USER_KEY = "simplenote_zh_user";
  var PURGE_KEY = "simplenote_zh_purged"; // 已永久删除的笔记 ID（墓碑，防止同步时被还原）
  var SINCE_KEY = "simplenote_zh_since";   // 增量同步游标：上次见过的服务端时间
  var PUSHED_KEY = "simplenote_zh_pushed"; // 各笔记"已成功同步时的修改时间"，用于增量推送
  var TOTAL_KEY = "simplenote_zh_total";   // 上次已知的服务端笔记总数（检测数据丢失）
  var DAV_KEY = "simplenote_zh_webdav";
  var IMGMODE_KEY = "simplenote_zh_imgmode"; // embed | path（插入图片的方式）
  // 纯浏览器环境（无 Electron）下的回退字体清单（均为 Windows 常见中文字体）
  var FALLBACK_FONTS = [
    "微软雅黑", "Microsoft YaHei", "等线", "Dengxian", "黑体", "SimHei",
    "宋体", "SimSun", "新宋体", "NSimSun", "楷体", "KaiTi",
    "仿宋", "FangSong", "华文细黑", "STXihei"
  ];

  // 安全存储：部分浏览器在 file:// 或隐私模式下会禁用 localStorage 并抛错，
  // 这里捕获异常并回退到内存，保证「直接双击 index.html」也能正常运行。
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

  // 笔记颜色标签调色板（在深浅两种模式下都保持辨识度）
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

  var state = {
    notes: [],
    currentId: null,
    query: "",
    activeTag: null,
    view: "notes", // 'notes' | 'trash'
    sort: "modified", // 'modified' | 'created' | 'title'
    themeMode: "auto", // 'auto' | 'light' | 'dark'
    systemDark: false, // 系统当前是否深色（auto 模式下决定实际配色）
    dark: false, // 实际生效的深色状态（由 themeMode + systemDark 推导）
    preview: false,
    fontFamily: "",
    fontSize: 16,
    token: "",
    user: "",
    serverUrl: "http://localhost:3000",
    lastSyncTs: 0,
    purged: [], // 永久删除的笔记 ID 墓碑
    since: 0,        // 增量拉取游标（服务端时间）
    pushed: {},      // 笔记 ID → 已成功同步时的修改时间（增量推送）
    serverTotal: 0,  // 上次已知的服务端笔记总数（变小则疑似数据丢失）
    legacyServer: false, // 服务端不支持增量（不返回 serverTime）
    dav: { server: "", username: "", password: "", dir: "/easynote" },
    imageMode: "embed", // 'embed' 内嵌进笔记 | 'path' 引用原文件路径
  };

  /* ---------------- 存储 ---------------- */
  function load() {
    try {
      state.notes = JSON.parse(store.getItem(STORE_KEY)) || [];
    } catch (e) {
      state.notes = [];
    }
    // 主题：迁移旧的布尔开关；无记录时默认跟随系统
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
    // 图片插入方式：默认内嵌（换设备也看得到）；"path" 为引用原文件路径（笔记体积小）
    var imgMode = store.getItem(IMGMODE_KEY);
    state.imageMode = imgMode === "path" ? "path" : "embed";
    state.serverUrl = store.getItem(SERVER_KEY) || "http://localhost:3000";
    state.token = store.getItem(TOKEN_KEY) || "";
    state.user = store.getItem(USER_KEY) || "";
    try {
      state.purged = JSON.parse(store.getItem(PURGE_KEY)) || [];
      if (!Array.isArray(state.purged)) state.purged = [];
    } catch (e) {
      state.purged = [];
    }
    // 增量同步游标（老版本没有这些键，默认 0 = 首次全量同步）
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
  var syncInFlight = false; // 是否有同步请求正在进行（防止并发）
  function save() {
    store.setItem(STORE_KEY, JSON.stringify(state.notes));
    if (state.token) scheduleSync();
  }
  function saveLocalOnly() {
    store.setItem(STORE_KEY, JSON.stringify(state.notes));
  }

  /* 落盘防抖：图片是内嵌 base64，带图笔记的内容动辄几 MB。
     逐字 JSON.stringify 全部笔记 + 写盘会让输入明显卡顿（带图笔记几乎没法继续打字），
     所以内存即时更新、持久化延后 600ms 并合并。 */
  var editorSaveTimer = null;
  function scheduleEditorSave() {
    if (editorSaveTimer) clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(function () {
      editorSaveTimer = null;
      save();
    }, 600);
  }
  function flushEditorSave() {
    if (!editorSaveTimer) return;
    clearTimeout(editorSaveTimer);
    editorSaveTimer = null;
    save();
  }
  // 过滤掉已被永久删除（墓碑）的笔记，防止同步时从服务端还原
  function filterPurged() {
    if (!state.purged.length) return;
    var before = state.notes.length;
    state.notes = state.notes.filter(function (n) {
      return state.purged.indexOf(n.id) === -1;
    });
    if (state.notes.length !== before) saveLocalOnly();
  }

  /* ---------------- 主题（跟随系统 / 手动） ---------------- */
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
    document.body.classList.toggle("dark", dark);
    // 同步标题栏颜色（Win/Linux 覆盖层、macOS 背景）
    if (window.electronAPI && window.electronAPI.setTitlebarDark) {
      window.electronAPI.setTitlebarDark(dark);
    }
  }
  function setThemeMode(mode) {
    state.themeMode = mode;
    store.setItem(THEME_KEY, mode);
    applyTheme();
    render();
  }

  /* ---------------- 工具 ---------------- */
  function uid() {
    return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function getTitle(note) {
    var lines = (note.content || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim().length) return lines[i].trim();
    }
    return "无标题";
  }
  function getSnippet(note) {
    var raw = note.content || "";
    // 摘要里不显示 markdown 图片/链接语法：图片替换为 [图片]，链接只留文字
    raw = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ");
    raw = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    var lines = raw.split("\n");
    var skipped = false;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim().length) {
        if (!skipped) { skipped = true; continue; }
        var s = lines[i].trim();
        return s.length > 120 ? s.slice(0, 120) + "…" : s;
      }
    }
    return "";
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

  /* ---------------- Markdown ---------------- */
  function escapeAttr(s) {
    return String(s)
      .replace(/"/g, "%22")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function inlineMd(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // 图片：![alt](url) → <img>，点击在外部程序打开。
      // file:// 的本地图片改写为 easynote-file://（主进程按路径读取），
      // 绕过 Chromium 对 file:// 页面跨目录加载图片的限制；原文件丢失时给出提示样式。
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_m, alt, url) {
        var src = /^file:\/\//i.test(url) ? "easynote-file://" + url.replace(/^file:\/\//i, "") : url;
        return '<img class="md-img" alt="' + escapeAttr(alt) + '" src="' + escapeAttr(src) +
          '" title="点击在外部打开" onerror="this.setAttribute(\'data-missing\',\'1\')">';
      })
      // 链接：[text](url) → <a data-mdlink>，点击用默认浏览器打开
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, t, url) {
        return '<a href="' + escapeAttr(url) + '" data-mdlink="1" rel="noopener">' + t + "</a>";
      });
  }
  function renderMarkdown(src) {
    // 注意：不能先对整段 escapeHtml——"> 引用" 的 > 会被转成 &gt;，块级引用就永远匹配不上。
    // 正确做法：逐行判定块级语法，输出时再对该行转义（inlineMd 不做转义）。
    var lines = String(src || "").split("\n");
    var out = [];
    var inList = false;
    var inCode = false;
    var codeBuf = [];
    var m;
    function closeList() {
      if (inList) { out.push(inList === "ol" ? "</ol>" : "</ul>"); inList = false; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) {
        if (inCode) {
          out.push("<pre><code>" + codeBuf.join("\n") + "</code></pre>");
          codeBuf = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(escapeHtml(line)); continue; }
      if ((m = line.match(/^### (.*)/))) { closeList(); out.push("<h3>" + inlineMd(escapeHtml(m[1])) + "</h3>"); continue; }
      if ((m = line.match(/^## (.*)/))) { closeList(); out.push("<h2>" + inlineMd(escapeHtml(m[1])) + "</h2>"); continue; }
      if ((m = line.match(/^# (.*)/))) { closeList(); out.push("<h1>" + inlineMd(escapeHtml(m[1])) + "</h1>"); continue; }
      if (/^---+$/.test(line)) { closeList(); out.push("<hr>"); continue; }
      if ((m = line.match(/^> (.*)/))) { closeList(); out.push("<blockquote>" + inlineMd(escapeHtml(m[1])) + "</blockquote>"); continue; }
      if ((m = line.match(/^\s*[-*] (.*)/))) {
        if (!inList) { out.push("<ul>"); inList = "ul"; }
        if (inList === "ol") { out.push("</ol>"); out.push("<ul>"); inList = "ul"; }
        out.push("<li>" + inlineMd(escapeHtml(m[1])) + "</li>");
        continue;
      }
      if ((m = line.match(/^\s*\d+\. (.*)/))) {
        if (!inList) { out.push("<ol>"); inList = "ol"; }
        if (inList === "ul") { out.push("</ul>"); out.push("<ol>"); inList = "ol"; }
        out.push("<li>" + inlineMd(escapeHtml(m[1])) + "</li>");
        continue;
      }
      if (line.trim() === "") {
        closeList();
        continue;
      }
      closeList();
      out.push("<p>" + inlineMd(escapeHtml(line)) + "</p>");
    }
    closeList();
    if (inCode) out.push("<pre><code>" + codeBuf.join("\n") + "</code></pre>");
    return out.join("\n");
  }

  /* ---------------- DOM 引用 ---------------- */
  var el = {};
  function cacheDom() {
    el.search = document.getElementById("search");
    el.tagList = document.getElementById("tagList");
    el.navNotes = document.getElementById("navNotes");
    el.navTrash = document.getElementById("navTrash");
    el.navDark = document.getElementById("navDark");
    el.navExport = document.getElementById("navExport");
    el.navImport = document.getElementById("navImport");
    el.newBtn = document.getElementById("newNoteBtn");
    el.sortSelect = document.getElementById("sortSelect");
    el.listTitle = document.getElementById("listTitle");
    el.noteList = document.getElementById("noteList");
    el.toolbar = document.getElementById("editorToolbar");
    el.editor = document.getElementById("editor");
    el.previewPane = document.getElementById("previewPane");
    el.editorEmpty = document.getElementById("editorEmpty");
    el.importFile = document.getElementById("importFile");
    el.infoModal = document.getElementById("infoModal");
    el.infoBody = document.getElementById("infoBody");
    el.infoClose = document.getElementById("infoClose");
    el.linkModal = document.getElementById("linkModal");
    el.linkUrl = document.getElementById("linkUrl");
    el.linkText = document.getElementById("linkText");
    el.linkConfirm = document.getElementById("linkConfirm");
    el.linkCancel = document.getElementById("linkCancel");
    el.imgFixBanner = document.getElementById("imgFixBanner");
    el.imgFixText = document.getElementById("imgFixText");
    el.imgFixBtn = document.getElementById("imgFixBtn");
    el.imgFixDismissBtn = document.getElementById("imgFixDismissBtn");
    el.btnEmbedImages = document.getElementById("btnEmbedImages");
    el.imgFixStatus = document.getElementById("imgFixStatus");
    el.navSettings = document.getElementById("navSettings");
    el.settingsModal = document.getElementById("settingsModal");
    el.settingsClose = document.getElementById("settingsClose");
    el.themeModeSelect = document.getElementById("themeModeSelect");
    el.imageModeSelect = document.getElementById("imageModeSelect");
    el.fontSelect = document.getElementById("fontSelect");
    el.fontCustom = document.getElementById("fontCustom");
    el.fontCustomApply = document.getElementById("fontCustomApply");
    el.fontSizeSelect = document.getElementById("fontSizeSelect");
    el.davUrl = document.getElementById("davUrl");
    el.davUser = document.getElementById("davUser");
    el.davPass = document.getElementById("davPass");
    el.davDir = document.getElementById("davDir");
    el.btnDavTest = document.getElementById("btnDavTest");
    el.btnDavExport = document.getElementById("btnDavExport");
    el.navAccount = document.getElementById("navAccount");
    el.navAccountLabel = document.getElementById("navAccountLabel");
    el.accountModal = document.getElementById("accountModal");
    el.accountClose = document.getElementById("accountClose");
    el.serverUrl = document.getElementById("serverUrl");
    el.accUser = document.getElementById("accUser");
    el.accPass = document.getElementById("accPass");
    el.btnLogin = document.getElementById("btnLogin");
    el.btnRegister = document.getElementById("btnRegister");
    el.btnTestConn = document.getElementById("btnTestConn");
    el.btnSync = document.getElementById("btnSync");
    el.btnLogout = document.getElementById("btnLogout");
    el.accLoggedOut = document.getElementById("accLoggedOut");
    el.accLoggedIn = document.getElementById("accLoggedIn");
    el.accName = document.getElementById("accName");
    el.syncStatus = document.getElementById("syncStatus");
  }

  /* ---------------- 过滤 / 排序 ---------------- */
  function getNotes() {
    var inTrash = state.view === "trash";
    var list = state.notes.filter(function (n) {
      // 用 !!.deleted 归一化：从服务端拉来的老笔记可能没有 deleted 字段，
      // 之前 n.deleted === false 会把这类笔记全部过滤掉（列表看起来"丢笔记"）。
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
    el.tagList.innerHTML = "";
    tags.forEach(function (t) {
      var li = document.createElement("li");
      li.className = "tag-item" + (state.activeTag === t ? " active" : "");
      li.textContent = "#" + t;
      li.addEventListener("click", function () {
        state.activeTag = state.activeTag === t ? null : t;
        state.view = "notes";
        el.search.value = "";
        state.query = "";
        render();
      });
      el.tagList.appendChild(li);
    });
  }

  function renderList() {
    var list = getNotes();
    el.noteList.innerHTML = "";
    if (list.length === 0) {
      var hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = state.view === "trash" ? "回收站为空" : "没有匹配的笔记";
      el.noteList.appendChild(hint);
      return;
    }
    list.forEach(function (n) {
      var item = document.createElement("div");
      item.className = "note-item" + (n.id === state.currentId ? " selected" : "");
      var title = document.createElement("div");
      title.className = "note-title";
      title.innerHTML = (n.color ? '<span class="note-color-dot" style="background:' + colorOf(n.color).color + '" title="' + colorOf(n.color).name + '"></span>' : "") + escapeHtml(getTitle(n)) + (n.pinned ? ' <span class="pin">📌</span>' : "");
      var snip = document.createElement("div");
      snip.className = "note-snippet";
      snip.textContent = getSnippet(n) || "没有更多文字";
      var meta = document.createElement("div");
      meta.className = "note-meta";
      meta.textContent = formatDate(n.modifiedDate) + (n.markdown ? " · Markdown" : "");
      item.appendChild(title);
      item.appendChild(snip);
      item.appendChild(meta);
      item.addEventListener("click", function () { selectNote(n.id); });
      item.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        openNoteMenu(e.clientX, e.clientY, n);
      });
      el.noteList.appendChild(item);
    });
  }

  function setToolbar(note) {
    if (state.view === "trash") {
      el.toolbar.innerHTML =
        '<button data-action="restore" title="恢复到笔记">♻ 恢复</button>' +
        '<button data-action="purge" title="永久删除">🗑 永久删除</button>' +
        '<button data-action="info" title="信息">ⓘ</button>';
    } else {
      el.toolbar.innerHTML =
        '<button data-action="pin" class="' + (note.pinned ? "active" : "") + '" title="置顶 / 取消置顶">📌</button>' +
        '<button data-action="color" class="' + (note.color ? "active" : "") + '" title="设置颜色标签">●</button>' +
        '<button data-action="markdown" class="' + (note.markdown ? "active" : "") + '" title="开启 / 关闭 Markdown">M↓</button>' +
        '<button data-action="preview" class="' + (state.preview ? "active" : "") + '" title="预览" ' + (note.markdown ? "" : "disabled") + ">👁</button>" +
        '<button data-action="insertText" title="插入文本（引用/代码/分隔线/日期）">文</button>' +
        '<button data-action="insertImage" title="插入图片">🖼</button>' +
        '<button data-action="insertLink" title="插入链接（点击可跳转）">🔗</button>' +
        '<button data-action="info" title="笔记信息">ⓘ</button>' +
        '<button data-action="share" title="复制内容到剪贴板">↗</button>' +
        '<button data-action="trash" title="移到回收站">🗑</button>' +
        '<button data-action="more" title="更多操作">⋯</button>';
    }
    var btns = el.toolbar.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function (e) {
        // 阻止冒泡到 document 的全局点击监听，否则本菜单会被立刻关掉
        if (e && e.stopPropagation) e.stopPropagation();
        handleAction(this.getAttribute("data-action"), note);
      });
    }
  }

  function renderEditor() {
    var note = state.notes.filter(function (n) { return n.id === state.currentId; })[0];
    var valid = note && !!note.deleted === (state.view === "trash");
    el.listTitle.textContent = state.view === "trash"
      ? "回收站"
      : state.activeTag ? "#" + state.activeTag : "全部笔记";

    if (!valid) {
      el.editorEmpty.classList.remove("hidden");
      el.editor.hidden = true;
      el.previewPane.hidden = true;
      el.toolbar.classList.add("hidden");
      el.toolbar.innerHTML = "";
      return;
    }
    el.editorEmpty.classList.add("hidden");
    el.toolbar.classList.remove("hidden");
    el.editor.readOnly = state.view === "trash";
    setToolbar(note);

    if (state.preview && note.markdown && !note.deleted) {
      // 「开着预览就没法加文字」：以前这里会把编辑器整个隐藏。
      // 改成上下分栏——上面是渲染结果（能看图），下面仍然是输入框，可以继续打字。
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

  function render() {
    el.navNotes.classList.toggle("active", state.view === "notes" && !state.activeTag);
    el.navTrash.classList.toggle("active", state.view === "trash");
    el.navDark.innerHTML = '<span class="nav-ico">' + (state.dark ? "☀" : "🌙") + "</span><span>" + (state.dark ? "浅色模式" : "深色模式") + "</span>";
    document.body.classList.toggle("dark", state.dark);
    renderTags();
    var list = getNotes();
    var cur = state.notes.filter(function (n) { return n.id === state.currentId; })[0];
    if (!cur || !!cur.deleted !== (state.view === "trash")) {
      state.currentId = list.length ? list[0].id : null;
    }
    renderList();
    renderEditor();
  }

  /* ---------------- 行为 ---------------- */
  function selectNote(id) {
    state.currentId = id;
    state.preview = false;
    render();
    if (state.view !== "trash") el.editor.focus();
  }

  function createNote() {
    var now = Date.now();
    var note = { id: uid(), content: "", pinned: false, markdown: false, deleted: false, color: "", createdDate: now, modifiedDate: now };
    state.notes.unshift(note);
    state.currentId = note.id;
    state.view = "notes";
    state.activeTag = null;
    state.query = "";
    el.search.value = "";
    state.preview = false;
    save();
    render();
    el.editor.focus();
  }

  /* 通用确认弹窗：删除 / 永久删除等破坏性操作前问一句，复用 .modal 样式 */
  function openConfirm(title, msg, onYes) {
    var m = document.createElement("div");
    m.className = "modal";
    var box = document.createElement("div");
    box.className = "modal-box";
    var h = document.createElement("h3");
    h.textContent = title || "确认";
    var p = document.createElement("p");
    p.textContent = msg || "";
    var actions = document.createElement("div");
    actions.className = "modal-actions";
    var cancel = document.createElement("button");
    cancel.className = "ghost";
    cancel.textContent = "取消";
    var yes = document.createElement("button");
    yes.className = "danger";
    yes.textContent = "确认";
    actions.appendChild(cancel);
    actions.appendChild(yes);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(actions);
    m.appendChild(box);
    document.body.appendChild(m);
    function close() { if (m.parentNode) m.parentNode.removeChild(m); }
    cancel.addEventListener("click", close);
    m.addEventListener("click", function (e) { if (e.target === m) close(); });
    yes.addEventListener("click", function () { close(); if (onYes) onYes(); });
    return close;
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
        note.pinned = !note.pinned; note.modifiedDate = Date.now(); save(); render(); break;
      case "markdown":
        note.markdown = !note.markdown; if (!note.markdown) state.preview = false; save(); render(); break;
      case "preview":
        if (note.markdown) { state.preview = !state.preview; render(); } break;
      case "info":
        showInfo(note); break;
      case "share":
        copyText(note.content); toast("已复制笔记内容到剪贴板"); break;
      case "more": {
        var mbtn = el.toolbar.querySelector('[data-action="more"]');
        var r = mbtn ? mbtn.getBoundingClientRect() : { left: 200, bottom: 80 };
        openNoteMenu(r.left, r.bottom + 4, note);
        break;
      }
      case "trash":
        openConfirm("移到回收站",
          "「" + noteCaption(note) + "」将被移到回收站，可在回收站里恢复。",
          function () {
            note.deleted = true; note.deletedDate = Date.now(); note.pinned = false; note.modifiedDate = Date.now();
            state.currentId = null; save(); render();
            toast("已移到回收站");
          });
        break;
      case "restore":
        note.deleted = false; note.deletedDate = null; note.modifiedDate = Date.now(); save(); render();
        toast("已恢复"); break;
      case "purge":
        openConfirm("永久删除",
          "「" + noteCaption(note) + "」将被永久删除，不可恢复，并同步删除所有设备上的这一条。",
          function () {
            // 记入墓碑再删除：服务端若是合并同步，墓碑可防止笔记被还原
            if (state.purged.indexOf(note.id) === -1) {
              state.purged.push(note.id);
              store.setItem(PURGE_KEY, JSON.stringify(state.purged));
            }
            state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
            if (state.currentId === note.id) state.currentId = null;
            purgeOnServer([note.id]);
            save(); render();
            toast("已永久删除");
          });
        break;
      case "color": {
        var cbtn = el.toolbar.querySelector('[data-action="color"]');
        var r = cbtn ? cbtn.getBoundingClientRect() : { left: 200, bottom: 80 };
        openColorMenu(r.left, r.bottom + 4, note);
        break;
      }
      case "insertText": {
        var tbtn = el.toolbar.querySelector('[data-action="insertText"]');
        var tr = tbtn ? tbtn.getBoundingClientRect() : { left: 200, bottom: 80 };
        openInsertTextMenu(tr.left, tr.bottom + 4);
        break;
      }
      case "insertImage":
        insertImage();
        break;
      case "insertLink":
        insertLink();
        break;
    }
  }

  // 颜色标签选择菜单
  function openColorMenu(x, y, note) {
    var items = COLOR_PALETTE.map(function (c) {
      return {
        label: (c.color ? "● " : "○ ") + c.name,
        color: c.color || null,
        action: function () {
          note.color = c.key;
          note.modifiedDate = Date.now();
          save();
          render();
          toast(c.key ? "已设置颜色：" + c.name : "已清除颜色");
        },
      };
    });
    showCtxMenu(x, y, items);
  }

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

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }

  function exportAll() {
    var data = JSON.stringify(state.notes, null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "simplenote-zh-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出备份");
  }

  function importAll(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var arr = JSON.parse(reader.result);
        if (Array.isArray(arr)) {
          state.notes = arr.concat(state.notes);
          save();
          render();
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

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    el.newBtn.addEventListener("click", createNote);

    el.navNotes.addEventListener("click", function () {
      state.view = "notes"; state.activeTag = null; render();
    });
    el.navTrash.addEventListener("click", function () {
      state.view = "trash"; render();
    });
    el.navDark.addEventListener("click", function () {
      // 点击切换到与当前生效状态相反的模式（显式指定，不再跟随系统）
      setThemeMode(state.dark ? "light" : "dark");
    });
    el.navExport.addEventListener("click", exportAll);
    el.navImport.addEventListener("click", function () { el.importFile.click(); });
    el.navSettings.addEventListener("click", openSettings);

    el.navAccount.addEventListener("click", openAccount);
    el.accountClose.addEventListener("click", function () { el.accountModal.hidden = true; });
    el.accountModal.addEventListener("click", function (e) {
      if (e.target === el.accountModal) el.accountModal.hidden = true;
    });
    el.btnLogin.addEventListener("click", function () { doAuth(false); });
    el.btnRegister.addEventListener("click", function () { doAuth(true); });
    if (el.btnTestConn) el.btnTestConn.addEventListener("click", testConnection);
    el.btnSync.addEventListener("click", function () { syncAll(); });
    el.btnLogout.addEventListener("click", logout);

    el.importFile.addEventListener("change", function (e) {
      var f = e.target.files[0];
      if (f) importAll(f);
      e.target.value = "";
    });

    el.search.addEventListener("input", function () {
      state.query = el.search.value;
      renderList();
    });
    el.sortSelect.addEventListener("change", function () {
      state.sort = el.sortSelect.value;
      renderList();
    });

    var debounce;
    var previewDebounce;
    el.editor.addEventListener("input", function () {
      var note = state.notes.filter(function (n) { return n.id === state.currentId; })[0];
      if (!note || note.deleted) return;
      note.content = el.editor.value;
      note.modifiedDate = Date.now();
      // 内存即时更新，落盘防抖（带图笔记内容大，逐字写盘会卡输入）
      scheduleEditorSave();
      clearTimeout(debounce);
      debounce = setTimeout(function () { renderList(); renderTags(); }, 250);
      // 开着预览时同步刷新渲染结果（图片笔记体积大，用更长的防抖）
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(function () {
        if (!el.previewPane.hidden) el.previewPane.innerHTML = renderMarkdown(el.editor.value);
      }, 700);
    });
    // 失焦 / 关窗前把待落盘的改动写掉，避免最后 600ms 内的输入丢失
    el.editor.addEventListener("blur", flushEditorSave);
    window.addEventListener("beforeunload", flushEditorSave);

    el.infoClose.addEventListener("click", function () { el.infoModal.hidden = true; });
    el.infoModal.addEventListener("click", function (e) {
      if (e.target === el.infoModal) el.infoModal.hidden = true;
    });

    // 编辑器右键菜单（全中文）
    el.editor.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      ctxX = e.clientX;
      ctxY = e.clientY;
      showCtxMenu(e.clientX, e.clientY, [
        { label: "撤销", shortcut: "Ctrl+Z", action: function () { el.editor.focus(); document.execCommand("undo"); } },
        { label: "重做", shortcut: "Ctrl+Y", action: function () { el.editor.focus(); document.execCommand("redo"); } },
        { sep: true },
        { label: "插入清单", action: function () { insertChecklist(); } },
        { label: "插入文本元素…", submenu: [
          { label: "引用块", action: function () { insertTextElement("quote"); } },
          { label: "代码块", action: function () { insertTextElement("code"); } },
          { label: "分隔线", action: function () { insertTextElement("hr"); } },
          { label: "当前日期时间", action: function () { insertTextElement("datetime"); } },
        ] },
        { label: "插入图片", action: function () { insertImage(); } },
        { label: "插入链接", action: function () { insertLink(); } },
        { sep: true },
        { label: "剪切", shortcut: "Ctrl+X", action: function () { document.execCommand("cut"); } },
        { label: "复制", shortcut: "Ctrl+C", action: function () { document.execCommand("copy"); } },
        { label: "粘贴", shortcut: "Ctrl+V", action: function () { pasteAtCursor(); } },
        { label: "全选", shortcut: "Ctrl+A", action: function () { el.editor.focus(); el.editor.select(); } },
      ]);
    });

    // 点击空白处关闭右键菜单
    document.addEventListener("click", hideCtxMenu);

    // 预览区：点击链接 / 图片 → 用默认浏览器或外部程序打开
    el.previewPane.addEventListener("click", function (e) {
      var a = e.target.closest("a[data-mdlink]");
      if (a) {
        e.preventDefault();
        var href = a.getAttribute("href");
        if (href) openExternal(href);
        return;
      }
      var img = e.target.closest("img.md-img");
      if (img) {
        e.preventDefault();
        var src = img.getAttribute("src");
        // 内嵌的 data: 图片无需用外部程序打开
        if (src && !/^data:/i.test(src)) openExternal(src);
      }
    });

    el.settingsClose.addEventListener("click", function () { el.settingsModal.hidden = true; });
    el.settingsModal.addEventListener("click", function (e) {
      if (e.target === el.settingsModal) el.settingsModal.hidden = true;
    });
    if (el.linkConfirm) el.linkConfirm.addEventListener("click", confirmLink);
    if (el.linkCancel) el.linkCancel.addEventListener("click", closeLinkModal);
    if (el.linkModal) el.linkModal.addEventListener("click", function (e) {
      if (e.target === el.linkModal) closeLinkModal();
    });
    if (el.imgFixBtn) el.imgFixBtn.addEventListener("click", embedExternalImages);
    if (el.btnEmbedImages) el.btnEmbedImages.addEventListener("click", embedExternalImages);
    if (el.imgFixDismissBtn) el.imgFixDismissBtn.addEventListener("click", function () {
      el.imgFixBanner.hidden = true;
    });
    if (el.linkUrl) el.linkUrl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); confirmLink(); }
    });
    if (el.linkText) el.linkText.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); confirmLink(); }
    });
    if (el.themeModeSelect) {
      el.themeModeSelect.addEventListener("change", function () {
        setThemeMode(el.themeModeSelect.value);
        toast("主题已切换");
      });
    }
    if (el.imageModeSelect) {
      el.imageModeSelect.addEventListener("change", function () {
        state.imageMode = el.imageModeSelect.value === "path" ? "path" : "embed";
        store.setItem(IMGMODE_KEY, state.imageMode);
        toast(state.imageMode === "path" ? "图片将引用原文件路径（笔记更小）" : "图片将内嵌进笔记（换设备也看得到）");
      });
    }
    el.fontSelect.addEventListener("change", function () {
      state.fontFamily = el.fontSelect.value;
      store.setItem(FONT_KEY, state.fontFamily);
      applySettings();
    });
    el.fontSizeSelect.addEventListener("change", function () {
      state.fontSize = parseInt(el.fontSizeSelect.value, 10) || 16;
      store.setItem(FONTSIZE_KEY, String(state.fontSize));
      applySettings();
    });
    el.fontCustomApply.addEventListener("click", applyCustomFont);
    el.fontCustom.addEventListener("keydown", function (e) {
      if (e.key === "Enter") applyCustomFont();
    });
    if (el.btnDavTest) el.btnDavTest.addEventListener("click", testDav);
    if (el.btnDavExport) el.btnDavExport.addEventListener("click", exportToDav);

    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createNote();
      }
      if (e.key === "Escape" && !el.infoModal.hidden) el.infoModal.hidden = true;
      if (e.key === "Escape" && el.linkModal && !el.linkModal.hidden) closeLinkModal();
    });
  }

  /* ---------------- 字体设置 ---------------- */
  // 空选择 = 跟随系统字体栈
  var SYSTEM_FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", ' +
    '"Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans CN", sans-serif';
  // 把字体值（单个字体名 / 逗号分隔的字体栈）组装成合法的 CSS font-family 列表
  function tellFamily(f) {
    f = (f || "").trim();
    if (!f) return "";
    if (/^["'].*["']$/.test(f)) return f;
    if (/[\s]/.test(f)) return '"' + f + '"';
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

  function fillFontSelect(fonts, hint) {
    if (!el.fontSelect) return;
    // 清洗字体列表：去掉极长 / 含不可打印或符号字符的族名（这些在默认 UI 字体里会显示成方块「乱码」）
    function looksOk(f) {
      if (!f || f.length > 48) return false;
      for (var i = 0; i < f.length; i++) {
        var c = f.charCodeAt(i);
        var printable = (c >= 0x20 && c <= 0x7e) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf);
        if (!printable) return false;
      }
      return true;
    }
    var clean = (fonts || []).filter(looksOk);
    el.fontSelect.innerHTML = "";
    var def = document.createElement("option");
    def.value = "";
    def.textContent = "默认（跟随系统）";
    el.fontSelect.appendChild(def);
    if (hint) {
      // 读取系统字体期间的占位提示（不可选中），保证下拉立刻有内容
      var tip = document.createElement("option");
      tip.value = "";
      tip.disabled = true;
      tip.textContent = hint;
      el.fontSelect.appendChild(tip);
    }
    clean.forEach(function (f) {
      var o = document.createElement("option");
      o.value = f;
      o.textContent = f;
      try { o.style.fontFamily = f; } catch (e) {} // 用字体自身预览，所见即所得
      el.fontSelect.appendChild(o);
    });
    // 当前选中的字体若不在列表里（自定义），补一个选项防止显示错位
    if (state.fontFamily) {
      var exists = false;
      var opts = el.fontSelect.options;
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === state.fontFamily) { exists = true; break; }
      }
      if (!exists) {
        var o2 = document.createElement("option");
        o2.value = state.fontFamily;
        o2.textContent = state.fontFamily + "（自定义）";
        try { o2.style.fontFamily = state.fontFamily; } catch (e) {}
        el.fontSelect.appendChild(o2);
      }
    }
    el.fontSelect.value = state.fontFamily || "";
  }

  function openSettings() {
    if (el.themeModeSelect) el.themeModeSelect.value = state.themeMode;
    if (el.imageModeSelect) el.imageModeSelect.value = state.imageMode;
    updateImgFixStatus();
    if (el.davUrl) el.davUrl.value = state.dav.server || "";
    if (el.davUser) el.davUser.value = state.dav.username || "";
    if (el.davPass) el.davPass.value = state.dav.password || "";
    if (el.davDir) el.davDir.value = state.dav.dir || "/easynote";
    if (el.fontSizeSelect) el.fontSizeSelect.value = String(state.fontSize || 16);
    if (el.fontCustom) el.fontCustom.value = state.fontFamily || "";
    // 关键：先把弹窗显示出来，再管字体列表。
    // 以前是先 await 系统字体（macOS 旧实现要冻 15 秒）再把弹窗 hidden=false，
    // 用户看到的就是「点设置，指针转半天」。现在弹窗立刻可用。
    el.settingsModal.hidden = false;

    // 字体下拉：先用兜底列表秒填，系统字体到了再整体替换（通常 <50ms，无感）
    fillFontSelect(FALLBACK_FONTS.slice(), "正在读取系统字体…");
    if (window.electronAPI && typeof window.electronAPI.getSystemFonts === "function") {
      window.electronAPI.getSystemFonts().then(function (list) {
        fillFontSelect(list && list.length ? list : FALLBACK_FONTS.slice());
      }).catch(function () {
        fillFontSelect(FALLBACK_FONTS.slice());
      });
    }
  }

  function applyCustomFont() {
    var v = (el.fontCustom.value || "").trim();
    if (!v) return;
    state.fontFamily = v;
    store.setItem(FONT_KEY, v);
    if (el.fontSelect) {
      var exists = false;
      var opts = el.fontSelect.options;
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === v) { exists = true; break; }
      }
      if (!exists) {
        var o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        el.fontSelect.appendChild(o);
      }
      el.fontSelect.value = v;
    }
    applySettings();
    toast("已应用字体：" + v);
  }

  /* ---------------- 云同步 / 账号 ---------------- */
  // 规范化服务端地址：自动补 http:// 前缀、去尾部斜杠；空值回退默认地址
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
    // 超时保护：请求挂起（网络黑洞 / 代理异常）时主动失败，避免卡住后续同步
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
          // 内嵌图片较多时整批笔记可能好几 MB，老服务端默认只收 100kb
          throw new Error("笔记内容过大，服务器拒绝接收（413）。请减少内嵌图片，或调大服务端请求体限制（见 server/README.md 的 BODY_LIMIT）");
        }
        if (!r.ok) throw new Error((data && data.error) ? data.error : "服务器返回错误 (" + r.status + ")");
        return data || {};
      });
    }).catch(function (e) {
      // 网络层失败（连不上/被拦截/超时）时，把技术性错误换成可操作的中文提示
      if (e && e.name === "AbortError") {
        throw new Error("连接服务器超时（60 秒无响应）。请检查服务端是否正常、网络是否稳定");
      }
      if (e && e.message && /failed to fetch|load failed|networkerror/i.test(e.message)) {
        throw new Error("无法连接服务器 " + url + "。请检查：① 地址是否填对（填 IP:端口 即可，会自动补 http://）② 服务端是否已启动 ③ 本机与服务端是否在同一局域网");
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
      storedAt: n.storedAt, // 服务端入库时间（同步响应里带回，服务端写入时会刷新）
    };
  }
  function setSyncStatus(txt) {
    if (el.syncStatus) el.syncStatus.textContent = txt;
  }
  function updateAccountUI() {
    if (state.token && state.user) {
      el.navAccountLabel.textContent = "云同步 · " + state.user;
      if (el.accLoggedIn) el.accLoggedIn.hidden = false;
      if (el.accLoggedOut) el.accLoggedOut.hidden = true;
      if (el.accName) el.accName.textContent = state.user;
      setSyncStatus("就绪");
    } else {
      el.navAccountLabel.textContent = "云同步";
      if (el.accLoggedIn) el.accLoggedIn.hidden = true;
      if (el.accLoggedOut) el.accLoggedOut.hidden = false;
    }
  }
  function openAccount() {
    if (el.serverUrl) el.serverUrl.value = normalizeServerUrl(state.serverUrl);
    updateAccountUI();
    el.accountModal.hidden = false;
  }
  function doAuth(isRegister) {
    var u = (el.accUser.value || "").trim();
    var p = el.accPass.value || "";
    var server = normalizeServerUrl((el.serverUrl.value || "").trim());
    if (!u || !p) { toast("请输入用户名和密码"); return; }
    el.serverUrl.value = server;
    state.serverUrl = server;
    store.setItem(SERVER_KEY, server);
    setSyncStatus(isRegister ? "注册中…" : "登录中…");
    api(isRegister ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ username: u, password: p }),
    }).then(function (res) {
      state.token = res.token;
      state.user = res.username;
      store.setItem(TOKEN_KEY, res.token);
      store.setItem(USER_KEY, res.username);
      updateAccountUI();
      resetSyncCursors(); // 新账号：全量推送本地 + 全量拉取
      startPeriodicSync();
      return syncAll();
    }).then(function () {
      toast(isRegister ? "注册成功，已同步" : "登录成功，已同步");
      el.accPass.value = "";
    }).catch(function (e) {
      setSyncStatus("错误：" + e.message);
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
    toast("已退出登录");
  }
  // 测试与服务端的连通性，立即反馈结果，便于定位问题
  function testConnection() {
    var server = normalizeServerUrl((el.serverUrl.value || "").trim());
    el.serverUrl.value = server;
    setSyncStatus("正在测试连接 " + server + " …");
    fetch(server + "/api/health")
      .then(function (r) {
        if (r.ok) {
          setSyncStatus("连接成功：" + server);
          toast("连接成功：" + server);
        } else {
          setSyncStatus("服务器有响应，但状态异常（HTTP " + r.status + "）");
          toast("连接异常：HTTP " + r.status);
        }
      })
      .catch(function () {
        setSyncStatus("连接失败：" + server);
        toast("连接失败：" + server + "，请检查地址、服务端与网络");
      });
  }
  var syncTimer;
  var periodicSyncTimer = null;
  var SYNC_INTERVAL_MS = 3000;      // 近实时同步：每 3 秒一轮（增量响应通常只有百余字节）
  var SYNC_DEBOUNCE_MS = 800;       // 本地改动后 0.8s 推送，接近"打完即同步"
  var syncInFlight = false;         // 是否有同步请求正在进行（防止并发）
  function scheduleSync() {
    if (!state.token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncAll, SYNC_DEBOUNCE_MS);
  }
  // 拉取合并：服务端版本更新则采用服务端的；本地修改更新则保留本地。
  // 返回是否有实际变更（决定是否需要重存/重渲染，避免每 3 秒无意义地全量重写）。
  function mergeNotes(incoming) {
    var byId = {};
    state.notes.forEach(function (n) { if (n && n.id) byId[n.id] = n; });
    var changed = false;
    (incoming || []).forEach(function (n) {
      if (!n || !n.id) return;
      var loc = byId[n.id];
      if (!loc) { byId[n.id] = n; changed = true; return; }
      if ((n.modifiedDate || 0) > (loc.modifiedDate || 0)) { byId[n.id] = n; changed = true; }
    });
    state.notes = Object.keys(byId).map(function (k) { return byId[k]; });
    return changed;
  }
  // 尚未成功推送的笔记（按各笔记"上次同步时的修改时间"判断，不受多设备时钟差异影响）
  function notesToPush() {
    return state.notes.filter(function (n) {
      var p = state.pushed[n.id];
      return !p || (n.modifiedDate || 0) > p;
    });
  }
  // 一次成功同步后，记录各笔记"已确认在服务端"的修改时间。
  // 只确认两类：① 本轮真正推上去的（且推送后没有被再次编辑）② 响应增量里回来的。
  // 推送过程中用户新改的笔记保持未确认状态，下一轮自动补推——防止"改完丢同步"。
  function markPushedAfterRound(pushedPayload, confirmed) {
    var next = {};
    state.notes.forEach(function (n) {
      if (!n || !n.id) return;
      var payloadTs = pushedPayload[n.id];
      if (confirmed && confirmed[n.id] !== undefined) {
        next[n.id] = confirmed[n.id]; // 服务端确认的版本（可能是别的设备更新的版本）
      } else if (payloadTs !== undefined && (n.modifiedDate || 0) <= payloadTs) {
        next[n.id] = payloadTs; // 本轮推上去的，且推送期间没有新编辑
      } else {
        next[n.id] = state.pushed[n.id] || 0; // 保持原状（可能仍待推送）
      }
    });
    state.pushed = next;
    store.setItem(PUSHED_KEY, JSON.stringify(next));
  }
  // 应用一次同步响应：合并增量、推进游标、检测服务端数据是否疑似丢失
  // 返回 { shrink: 是否疑似数据丢失, changed: 本地是否被服务端更新, confirmed: 响应确认的笔记修改时间 }
  function applySyncResponse(res) {
    var changed = false;
    var confirmed = {};
    if (res && res.notes) {
      (res.notes || []).forEach(function (n) { if (n && n.id) confirmed[n.id] = n.modifiedDate || 0; });
      changed = mergeNotes(res.notes);
      if (changed) filterPurged(); // 服务端若仍保留已永久删除的笔记，本地用墓碑过滤掉
    }
    // 跨端墓碑：其他设备永久删除的笔记，本地也清掉，保持回收站一致
    if (res && res.removed && res.removed.length) {
      var removedSet = {};
      res.removed.forEach(function (id) { removedSet[id] = true; if (state.purged.indexOf(id) === -1) state.purged.push(id); });
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
      // 老服务端不返回 serverTime：退化为全量轮询（间隔拉长，避免反复拉全量）
      if (!state.legacyServer) { state.legacyServer = true; startPeriodicSync(); }
    }
    if (res && typeof res.total === "number") {
      if (state.serverTotal > 0 && res.total < state.serverTotal) {
        // 服务端笔记数变少（数据文件丢失/被旧备份覆盖）：全量拉回并全量重推，尽量恢复
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
    // 增量推送 + 增量拉取合一：没有改动时请求体只有几十字节；老服务端退化为 30s 全量轮询
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
    if (syncInFlight) return Promise.resolve(); // 上一轮还没回来，跳过本轮
    syncInFlight = true;
    var pending = notesToPush().map(serializeNote);
    var pushedPayload = {}; // 本轮真正推上去的笔记及其修改时间
    pending.forEach(function (n) { pushedPayload[n.id] = n.modifiedDate || 0; });
    if (pending.length) setSyncStatus("同步中…");
    return api("/api/notes/sync", {
      method: "POST",
      body: JSON.stringify({ notes: pending, since: state.since || 0 }),
    })
      .then(function (res) {
        var r = applySyncResponse(res);
        if (!r.shrink) {
          if (r.changed) { saveLocalOnly(); render(); } // 有其他设备的改动才重存/重渲染
          if (pending.length || r.changed) {
            markPushedAfterRound(pushedPayload, r.confirmed);
            updateImgFixStatus(); // 同步后重新检测外链图片
          }
          state.lastSyncTs = Date.now();
          setSyncStatus("已同步 · " + new Date().toLocaleTimeString("zh-CN"));
        }
        return r.shrink;
      })
      .catch(function (e) {
        setSyncStatus("同步失败：" + e.message);
        return false;
      })
      .then(function (shrink) {
        syncInFlight = false;
        if (shrink) recoverFromShrink();
      });
  }
  // 服务端疑似数据丢失后的恢复：全量拉回 → 全量重推
  function recoverFromShrink() {
    pullOnly(true).then(function () { syncAll(); });
  }
  function pullOnly(forceFull) {
    // 游标是服务端时间（响应里的 serverTime），无需回退；服务端按"入库时间"过滤
    var since = forceFull ? 0 : (state.since || 0);
    return api("/api/notes?since=" + since, { method: "GET" }).then(function (res) {
      var r = applySyncResponse(res);
      if (!r.shrink && r.changed) markPushedAfterRound({}, r.confirmed);
      if (r.shrink) recoverFromShrink();
      return res;
    });
  }
  // 切换账号 / 退出登录时重置同步游标，避免把上个账号的增量状态带到新账号
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
      .catch(function () { /* 失败不阻塞本地删除 */ });
  }

  /* ---------------- WebDAV 导出 ---------------- */
  function saveDavConfig() {
    state.dav.server = (el.davUrl.value || "").trim();
    state.dav.username = (el.davUser.value || "").trim();
    state.dav.password = el.davPass.value || "";
    state.dav.dir = (el.davDir.value || "").trim() || "/easynote";
    store.setItem(DAV_KEY, JSON.stringify(state.dav));
  }
  function davConfig() {
    return {
      server: (el.davUrl.value || "").trim(),
      username: (el.davUser.value || "").trim(),
      password: el.davPass.value || "",
      dir: (el.davDir.value || "").trim() || "/easynote",
    };
  }
  function testDav() {
    var cfg = davConfig();
    if (!cfg.server) { toast("请先填写 WebDAV 服务器地址"); return; }
    saveDavConfig();
    toast("正在测试连接…");
    window.electronAPI.webdavTest(cfg).then(function (r) {
      if (r.ok) {
        toast(r.needMkcol ? "连接成功（目录不存在，导出时会自动创建）" : "连接成功");
      } else {
        toast("连接失败：" + (r.error || "未知错误"));
      }
    });
  }
  function exportToDav() {
    var cfg = davConfig();
    if (!cfg.server) { toast("请先填写 WebDAV 服务器地址"); return; }
    if (!state.notes.length) { toast("没有可导出的笔记"); return; }
    saveDavConfig();
    toast("正在导出 " + state.notes.length + " 条笔记…");
    window.electronAPI.webdavExport(cfg, state.notes.map(serializeNote)).then(function (r) {
      if (r.ok) {
        toast("导出完成：" + r.count + "/" + r.total + " 条 → " + r.url);
      } else if (typeof r.count === "number") {
        toast("部分失败：" + r.count + "/" + r.total + "，失败 " + r.failed.length + " 条");
      } else {
        toast("导出失败：" + (r.error || "未知错误"));
      }
    });
  }

  /* ---------------- 右键菜单 ---------------- */
  var ctxEl = null;
  function ensureCtxMenu() {
    if (!ctxEl) {
      ctxEl = document.createElement("div");
      ctxEl.className = "ctx-menu";
      ctxEl.hidden = true;
      document.body.appendChild(ctxEl);
    }
    return ctxEl;
  }
  function showCtxMenu(x, y, items) {
    var m = ensureCtxMenu();
    m.innerHTML = "";
    items.forEach(function (it) {
      if (it.sep) {
        var s = document.createElement("div");
        s.className = "ctx-sep";
        m.appendChild(s);
        return;
      }
      var row = document.createElement("div");
      row.className = "ctx-item" + (it.danger ? " danger" : "") + (it.submenu ? " has-sub" : "");
      var lbl = document.createElement("span");
      lbl.textContent = it.label;
      if (it.color) lbl.style.color = it.color;
      row.appendChild(lbl);
      if (it.submenu) {
        var ar = document.createElement("span");
        ar.className = "shortcut";
        ar.textContent = "▸";
        row.appendChild(ar);
      } else if (it.shortcut) {
        var sc = document.createElement("span");
        sc.className = "shortcut";
        sc.textContent = it.shortcut;
        row.appendChild(sc);
      }
      row.addEventListener("click", function (e) {
        e.stopPropagation();
        if (it.submenu) {
          // 在该项右侧展开子菜单（替换当前菜单内容）
          var rect = row.getBoundingClientRect();
          showCtxMenu(rect.right - 4, rect.top - 4, it.submenu);
          return;
        }
        hideCtxMenu();
        if (it.action) it.action();
      });
      m.appendChild(row);
    });
    m.hidden = false;
    var w = m.offsetWidth, h = m.offsetHeight;
    if (x + w > window.innerWidth) x = window.innerWidth - w - 6;
    if (y + h > window.innerHeight) y = window.innerHeight - h - 6;
    if (x < 6) x = 6;
    if (y < 6) y = 6;
    m.style.left = x + "px";
    m.style.top = y + "px";
  }
  function hideCtxMenu() {
    if (ctxEl) ctxEl.hidden = true;
  }

  function openNoteMenu(x, y, note) {
    var items = [
      { label: note.pinned ? "取消置顶" : "置顶", action: function () { handleAction("pin", note); } },
      { label: note.markdown ? "关闭 Markdown" : "开启 Markdown", action: function () { handleAction("markdown", note); } },
      { label: "设置颜色…", color: note.color ? colorOf(note.color).color : null, action: function () { handleAction("color", note); } },
      { sep: true },
      { label: "复制内部链接", action: function () { copyInternalLink(note); } },
      { label: "复制内容到剪贴板", action: function () { handleAction("share", note); } },
      { sep: true },
      { label: "历史记录", action: function () { toast("历史记录功能即将开放"); } },
      { label: "发布到网络", action: function () { toast("发布功能即将开放"); } },
      { sep: true },
      { label: "移动到回收站", danger: true, action: function () { handleAction("trash", note); } },
    ];
    showCtxMenu(x, y, items);
  }

  function copyInternalLink(note) {
    var link = "easynote://note/" + note.id;
    copyText(link);
    toast("已复制内部链接：" + link);
  }

  function insertChecklist() {
    var ta = el.editor;
    var note = state.notes.filter(function (n) { return n.id === state.currentId; })[0];
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

  /* ---------------- 插入文本 / 图片 / 链接 ---------------- */
  var ctxX = 0, ctxY = 0; // 记录右键坐标，供子菜单定位

  function currentNote() {
    return state.notes.filter(function (n) { return n.id === state.currentId; })[0] || null;
  }

  // 在光标处插入文本（替换当前选区），并触发 input 保存
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

  // 用默认浏览器 / 外部程序打开地址（Electron 走主进程，纯网页走 window.open）
  function openExternal(url) {
    var api = window.electronAPI;
    if (api && api.openExternal) {
      api.openExternal(url);
    } else if (url) {
      window.open(url, "_blank");
    }
  }

  // 修复：右键「粘贴」——从系统剪贴板读取文本并插入（document.execCommand("paste") 在隔离环境不可靠）
  function pasteAtCursor() {
    var ta = el.editor;
    var note = currentNote();
    if (!note || note.deleted) return;
    el.editor.focus();
    var api = window.electronAPI;
    if (api && api.getClipboardText) {
      api.getClipboardText().then(function (text) {
        if (text == null) text = "";
        if (!text) { toast("剪贴板为空或无法读取"); return; }
        insertAtCursor(ta, text);
        triggerInput(ta);
      }).catch(function () { toast("无法读取剪贴板"); });
    } else if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) {
        insertAtCursor(ta, t || "");
        triggerInput(ta);
      }).catch(function () { try { document.execCommand("paste"); } catch (e) {} });
    } else {
      try { document.execCommand("paste"); } catch (e) {}
    }
  }

  // 绝对路径 → file:// URL（macOS/Windows 通用）
  function fileUrl(p) {
    if (/^file:\/\//i.test(p)) return p;
    var norm = String(p).replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(norm)) return "file:///" + norm; // Windows 盘符
    return "file://" + norm; // Unix 绝对路径
  }

  function insertImage() {
    var note = currentNote();
    if (!note || note.deleted) return;
    var api = window.electronAPI;
    if (!api || !api.pickImage) { toast("当前环境不支持选择图片"); return; }
    var mode = state.imageMode === "path" ? "path" : "embed";
    api.pickImage(mode).then(function (r) {
      if (!r) return;
      var name = r.name || "图片";
      var md;
      if (mode === "path" && r.path) {
        // 引用模式：笔记里存 file:// 路径（体积小、通用），
        // 预览时由主进程经 easynote-file:// 自定义协议读取显示
        md = "\n![" + name + "](" + fileUrl(r.path) + ")\n";
      } else {
        if (!r.dataUrl) { toast("插入图片失败"); return; }
        // 内嵌模式：data URI 写进笔记，不受 file:// 跨目录限制，三端均可显示
        md = "\n![" + name + "](" + r.dataUrl + ")\n";
      }
      insertAtCursor(el.editor, md);
      triggerInput(el.editor);
      // 图片需 Markdown + 预览才能显示：自动开启本笔记的 Markdown（启用 👁 预览按钮）
      if (!note.markdown) { note.markdown = true; save(); setToolbar(note); }
      toast(mode === "path"
        ? "已插入图片（引用原文件），点 👁 预览查看"
        : "已插入图片，点 👁 预览查看（图片已内嵌保存）");
    }).catch(function () { toast("插入图片失败"); });
  }

  // 插入链接：用自定义弹窗（window.prompt 在 Electron 打包环境会被静默拦截）
  function insertLink() {
    var note = currentNote();
    if (!note || note.deleted) return;
    var ta = el.editor;
    var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    el._linkSel = sel;
    el.linkUrl.value = "https://";
    el.linkText.value = sel || "";
    el.linkModal.hidden = false;
    el.linkUrl.focus();
    el.linkUrl.select();
  }
  function confirmLink() {
    var url = (el.linkUrl.value || "").trim();
    if (!url) { toast("链接地址不能为空"); el.linkUrl.focus(); return; }
    var text = (el.linkText.value || "").trim() || url;
    var ta = el.editor;
    var md = "[" + text + "](" + url + ")";
    if (el._linkSel) {
      // 替换当前选中文字
      var start = ta.selectionStart, end = ta.selectionEnd, val = ta.value;
      ta.value = val.slice(0, start) + md + val.slice(end);
      ta.selectionStart = ta.selectionEnd = start + md.length;
    } else {
      insertAtCursor(ta, md);
    }
    triggerInput(ta);
    el.linkModal.hidden = true;
    // 链接需 Markdown + 预览才能渲染：自动开启本笔记的 Markdown
    var note = currentNote();
    if (note && !note.markdown) { note.markdown = true; save(); setToolbar(note); }
    toast("已插入链接（点 👁 预览 / 点击可打开）");
  }
  function closeLinkModal() {
    el.linkModal.hidden = true;
  }

  /* ---------------- 外链图片一键转内嵌（修复跨设备看不到图） ----------------
   * 早期版本 / 「引用路径」模式下，图片在笔记里存的是 file:// 或
   * easynote-file:// 本机路径：只有保存图片的那台电脑能显示，同步到
   * Windows / Linux 后对方读不到你机器的文件，图片就不显示。
   * 这里把本机还能找到原图的引用批量转成 data: URI 内嵌，
   * 保存并同步后，所有设备都能显示。 */
  var EXTERNAL_IMG_RE = /!\[[^\]]*\]\((?:file|easynote-file):\/\/[^)\s]+\)/g;

  // file:// / easynote-file:// URL → 本地绝对路径
  function urlToLocalPath(u) {
    var s = String(u || "");
    s = s.replace(/^easynote-file:\/\//i, "").replace(/^file:\/\//i, "");
    try { s = decodeURIComponent(s); } catch (e) {}
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1); // Windows: /C:/x → C:/x
    return s;
  }

  // 扫描全部笔记里的外链图片引用，返回 { paths, noteCount, refCount }
  function collectExternalImages() {
    var paths = {};
    var noteCount = 0, refCount = 0;
    state.notes.forEach(function (n) {
      if (!n || n.deleted) return;
      var c = n.content || "";
      var m, has = false;
      EXTERNAL_IMG_RE.lastIndex = 0;
      while ((m = EXTERNAL_IMG_RE.exec(c)) !== null) {
        var inner = /\(((?:file|easynote-file):\/\/[^)\s]+)\)/.exec(m[0]);
        var p = inner ? urlToLocalPath(inner[1]) : "";
        if (p) { paths[p] = true; refCount++; has = true; }
      }
      if (has) noteCount++;
    });
    return { paths: Object.keys(paths), noteCount: noteCount, refCount: refCount };
  }

  function embedExternalImages() {
    var api = window.electronAPI;
    if (!api || !api.embedImagePaths) { toast("当前环境不支持该操作"); return; }
    var found = collectExternalImages();
    if (!found.paths.length) { toast("没有需要修复的外链图片"); updateImgFixStatus(); return; }
    if (el.btnEmbedImages) el.btnEmbedImages.disabled = true;
    toast("正在修复 " + found.refCount + " 处外链图片…");
    api.embedImagePaths(found.paths).then(function (map) {
      map = map || {};
      var fixedFiles = Object.keys(map).length;
      var replaced = 0;
      state.notes.forEach(function (n) {
        if (!n || n.deleted) return;
        var c = n.content || "";
        var orig = c;
        c = c.replace(EXTERNAL_IMG_RE, function (whole) {
          var inner = /\(((?:file|easynote-file):\/\/[^)\s]+)\)/.exec(whole);
          var p = inner ? urlToLocalPath(inner[1]) : "";
          if (p && map[p]) { replaced++; return whole.replace(inner[1], map[p]); }
          return whole;
        });
        if (c !== orig) { n.content = c; n.modifiedDate = Date.now(); }
      });
      save(); // 保存并触发同步：其他设备拉取后即可显示
      render();
      updateImgFixStatus();
      var msg = "已修复 " + fixedFiles + " 张图片（" + replaced + " 处引用已内嵌，同步后其他设备即可显示）";
      var missing = found.paths.length - fixedFiles;
      if (missing > 0) {
        msg += "；另有 " + missing + " 张在本机找不到原文件，未能修复——请到存有这些图片的电脑上打开简易笔记，重新点「一键修复」并同步";
      }
      toast(msg);
    }).catch(function () {
      toast("修复失败，请重试");
    }).then(function () {
      if (el.btnEmbedImages) el.btnEmbedImages.disabled = false;
    });
  }

  // 刷新「外链图片」检测状态：设置弹窗里的说明 + 侧栏提示横幅
  function updateImgFixStatus() {
    var found = collectExternalImages();
    if (el.imgFixStatus) {
      el.imgFixStatus.textContent = found.refCount
        ? "检测到 " + found.noteCount + " 条笔记中有 " + found.refCount + " 处外链图片（只在本机可见，换设备显示不了）。点「一键修复」把它们转成内嵌，保存同步后所有设备都能看。"
        : "未检测到外链图片：当前笔记里的图片都已内嵌保存（或暂无图片）。";
    }
    if (el.imgFixBanner) {
      if (found.refCount) {
        if (el.imgFixText) {
          el.imgFixText.textContent = "检测到 " + found.refCount + " 处外链图片，其他设备可能看不到，点「修复」";
        }
        el.imgFixBanner.hidden = false;
      } else {
        el.imgFixBanner.hidden = true;
      }
    }
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

  function openInsertTextMenu(x, y) {
    showCtxMenu(x, y, [
      { label: "引用块", action: function () { insertTextElement("quote"); } },
      { label: "代码块", action: function () { insertTextElement("code"); } },
      { label: "分隔线", action: function () { insertTextElement("hr"); } },
      { label: "当前日期时间", action: function () { insertTextElement("datetime"); } },
    ]);
  }

  /* ---------------- 初始化 ---------------- */
  function seedIfEmpty() {
    if (state.notes.length === 0) {
      var now = Date.now();
      state.notes.push({
        id: uid(),
        content:
          "欢迎使用简易笔记\n\n这是一个高度还原 Simplenote 的纯中文笔记软件，支持账号云同步与多端使用。\n\n# 功能一览\n- 三栏布局：标签 / 列表 / 编辑器\n- 搜索、标签（用 #标签 语法）、置顶\n- Markdown 编辑与实时预览\n- 回收站、深色模式、导入导出\n- 在编辑器或笔记上点右键，有中文快捷菜单\n- 工具栏「⋯」可置顶、复制内部链接、移动到回收站\n\n**加粗**、*斜体*、`行内代码` 都支持。\n点击顶部工具栏的 M↓ 开启 Markdown，再点 👁 预览。",
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
    filterPurged(); // 启动即过滤墓碑，防止已删笔记复活
    applySettings();
    bindEvents();
    updateAccountUI();
    // 跟随系统深浅色：主进程系统主题变化 / 浏览器环境媒体查询
    if (window.electronAPI && window.electronAPI.onSystemThemeChanged) {
      window.electronAPI.onSystemThemeChanged(function (dark) {
        state.systemDark = !!dark;
        if (state.themeMode === "auto") {
          applyTheme();
          render();
        }
      });
    }
    if (window.matchMedia) {
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
          if (state.themeMode === "auto") {
            applyTheme();
            render();
          }
        });
      } catch (e) {}
    }
    // 标题栏双击最大化 / 还原
    var strip = document.getElementById("titlebarStrip");
    if (strip && window.electronAPI && window.electronAPI.toggleMaximize) {
      strip.addEventListener("dblclick", function () {
        window.electronAPI.toggleMaximize();
      });
    }
    if (state.token) {
      render(); // 先把本地笔记显示出来，再同步
      // 启动即同步：推送本地未同步的修改，并拉取其他设备的增量改动
      syncAll().then(function () {
        if (state.notes.length === 0) { seedIfEmpty(); saveLocalOnly(); render(); }
      });
      startPeriodicSync(); // 每 3 秒一轮增量同步，其它设备保存后本机随即显示
    } else {
      seedIfEmpty();
      render();
    }
    // 启动后延迟检测一次外链图片（避免阻塞首屏渲染）
    setTimeout(updateImgFixStatus, 800);
    if (window.electronAPI && window.electronAPI.onMenuNewNote) {
      window.electronAPI.onMenuNewNote(function () {
        var b = document.getElementById("newNoteBtn");
        if (b) b.click();
      });
    }
    initVersionAndUpdate();
  }

  // ============ 版本号显示与更新提示（仅 Electron 环境） ============
  function initVersionAndUpdate() {
    var api = window.electronAPI;
    if (!api || !api.getAppVersion) return;

    var badge = document.getElementById("appVersion");
    var banner = document.getElementById("updateBanner");
    var text = document.getElementById("updateText");
    var dl = document.getElementById("updateDownloadBtn");
    var dismiss = document.getElementById("updateDismissBtn");

    var appVersion = "";
    var releaseUrl = "";
    var bannerTimer = null;

    api.getAppVersion().then(function (v) {
      appVersion = v || "";
      if (badge) badge.textContent = "v" + appVersion;
    });

    // 侧栏横幅作为统一提示条：发现新版本 / 已是最新 / 检查失败（可重试）
    function showBanner(msg, actionLabel, actionFn, autoHideMs) {
      if (!banner) return;
      if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
      if (text) text.textContent = msg;
      if (dl) {
        if (actionLabel && actionFn) {
          dl.textContent = actionLabel;
          dl.hidden = false;
          dl.onclick = actionFn;
        } else {
          dl.hidden = true;
          dl.onclick = null;
        }
      }
      banner.hidden = false;
      if (autoHideMs) {
        bannerTimer = setTimeout(function () { banner.hidden = true; }, autoHideMs);
      }
    }

    function showUpdate(info) {
      if (!info || !info.version) return;
      releaseUrl = info.url || "";
      showBanner("发现新版本 v" + info.version, "下载", function () {
        if (releaseUrl && api.openExternal) api.openExternal(releaseUrl);
      });
    }

    if (banner) {
      // 主进程自动检查发现新版本时推送（启动 5 秒后 / 每 6 小时 / 失败 10 分钟重试）
      api.onUpdateAvailable(showUpdate);
      if (dismiss) {
        dismiss.addEventListener("click", function () { banner.hidden = true; });
      }
    }

    // 点击版本徽标 → 手动检查更新，结果明确可见（不再静默重置）
    function manualCheck() {
      if (!api.checkUpdate) return;
      if (badge) badge.textContent = "检查中…";
      api.checkUpdate().then(function (r) {
        api.getAppVersion().then(function (v) {
          appVersion = v || "";
          if (badge) badge.textContent = "v" + appVersion;
        });
        if (r && r.ok && r.hasUpdate && r.latest) {
          showUpdate(r.latest); // 事件通道通常会先到，这里双保险
        } else if (r && r.ok) {
          showBanner("✓ 已是最新版本 v" + appVersion, null, null, 4000);
        } else {
          showBanner("检查更新失败：网络不可达", "重试", manualCheck, 15000);
        }
      }).catch(function () {
        if (badge) badge.textContent = "v" + appVersion;
        showBanner("检查更新失败：网络不可达", "重试", manualCheck, 15000);
      });
    }
    if (badge && api.checkUpdate) {
      badge.style.cursor = "pointer";
      badge.title = "点击检查更新";
      badge.addEventListener("click", manualCheck);
    }
  }

  init();
})();
