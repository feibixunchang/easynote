/* ============ 简易笔记 · 核心逻辑 ============ */
(function () {
  "use strict";

  var STORE_KEY = "simplenote_zh_v1";
  var DARK_KEY = "simplenote_zh_dark";
  var FONT_KEY = "simplenote_zh_font";
  var FONTSIZE_KEY = "simplenote_zh_fontsize";
  var SERVER_KEY = "simplenote_zh_server";
  var TOKEN_KEY = "simplenote_zh_token";
  var USER_KEY = "simplenote_zh_user";
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

  var state = {
    notes: [],
    currentId: null,
    query: "",
    activeTag: null,
    view: "notes", // 'notes' | 'trash'
    sort: "modified", // 'modified' | 'created' | 'title'
    dark: false,
    preview: false,
    fontFamily: "",
    fontSize: 16,
    token: "",
    user: "",
    serverUrl: "http://localhost:3000",
    lastSyncTs: 0,
  };

  /* ---------------- 存储 ---------------- */
  function load() {
    try {
      state.notes = JSON.parse(store.getItem(STORE_KEY)) || [];
    } catch (e) {
      state.notes = [];
    }
    state.dark = store.getItem(DARK_KEY) === "1";
    state.fontFamily = store.getItem(FONT_KEY) || "";
    state.fontSize = parseInt(store.getItem(FONTSIZE_KEY) || "16", 10) || 16;
    state.serverUrl = store.getItem(SERVER_KEY) || "http://localhost:3000";
    state.token = store.getItem(TOKEN_KEY) || "";
    state.user = store.getItem(USER_KEY) || "";
  }
  function save() {
    store.setItem(STORE_KEY, JSON.stringify(state.notes));
    if (state.token) scheduleSync();
  }
  function saveLocalOnly() {
    store.setItem(STORE_KEY, JSON.stringify(state.notes));
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
    var lines = (note.content || "").split("\n");
    var skipped = false;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim().length) {
        if (!skipped) { skipped = true; continue; }
        return lines[i].trim();
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
  function inlineMd(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function renderMarkdown(src) {
    var lines = escapeHtml(src).split("\n");
    var out = [];
    var inList = false;
    var inCode = false;
    var codeBuf = [];
    var m;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) {
        if (inCode) {
          out.push("<pre><code>" + codeBuf.join("\n") + "</code></pre>");
          codeBuf = [];
          inCode = false;
        } else {
          if (inList) { out.push(inList === "ol" ? "</ol>" : "</ul>"); inList = false; }
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      if ((m = line.match(/^### (.*)/))) { if (inList) { out.push("</ul>"); inList = false; } out.push("<h3>" + inlineMd(m[1]) + "</h3>"); continue; }
      if ((m = line.match(/^## (.*)/))) { if (inList) { out.push("</ul>"); inList = false; } out.push("<h2>" + inlineMd(m[1]) + "</h2>"); continue; }
      if ((m = line.match(/^# (.*)/))) { if (inList) { out.push("</ul>"); inList = false; } out.push("<h1>" + inlineMd(m[1]) + "</h1>"); continue; }
      if (/^---+$/.test(line)) { if (inList) { out.push("</ul>"); inList = false; } out.push("<hr>"); continue; }
      if ((m = line.match(/^> (.*)/))) { if (inList) { out.push("</ul>"); inList = false; } out.push("<blockquote>" + inlineMd(m[1]) + "</blockquote>"); continue; }
      if ((m = line.match(/^\s*[-*] (.*)/))) {
        if (!inList) { out.push("<ul>"); inList = "ul"; }
        if (inList === "ol") { out.push("</ol>"); out.push("<ul>"); inList = "ul"; }
        out.push("<li>" + inlineMd(m[1]) + "</li>");
        continue;
      }
      if ((m = line.match(/^\s*\d+\. (.*)/))) {
        if (!inList) { out.push("<ol>"); inList = "ol"; }
        if (inList === "ul") { out.push("</ul>"); out.push("<ol>"); inList = "ol"; }
        out.push("<li>" + inlineMd(m[1]) + "</li>");
        continue;
      }
      if (line.trim() === "") {
        if (inList) { out.push(inList === "ol" ? "</ol>" : "</ul>"); inList = false; }
        continue;
      }
      if (inList) { out.push(inList === "ol" ? "</ol>" : "</ul>"); inList = false; }
      out.push("<p>" + inlineMd(line) + "</p>");
    }
    if (inList) out.push(inList === "ol" ? "</ol>" : "</ul>");
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
    el.navSettings = document.getElementById("navSettings");
    el.settingsModal = document.getElementById("settingsModal");
    el.settingsClose = document.getElementById("settingsClose");
    el.fontSelect = document.getElementById("fontSelect");
    el.fontCustom = document.getElementById("fontCustom");
    el.fontCustomApply = document.getElementById("fontCustomApply");
    el.fontSizeSelect = document.getElementById("fontSizeSelect");
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
    var list = state.notes.filter(function (n) {
      return n.deleted === (state.view === "trash");
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
      title.innerHTML = escapeHtml(getTitle(n)) + (n.pinned ? ' <span class="pin">📌</span>' : "");
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
        '<button data-action="markdown" class="' + (note.markdown ? "active" : "") + '" title="开启 / 关闭 Markdown">M↓</button>' +
        '<button data-action="preview" class="' + (state.preview ? "active" : "") + '" title="预览" ' + (note.markdown ? "" : "disabled") + ">👁</button>" +
        '<button data-action="info" title="笔记信息">ⓘ</button>' +
        '<button data-action="share" title="复制内容到剪贴板">↗</button>' +
        '<button data-action="trash" title="移到回收站">🗑</button>' +
        '<button data-action="more" title="更多操作">⋯</button>';
    }
    var btns = el.toolbar.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        handleAction(this.getAttribute("data-action"), note);
      });
    }
  }

  function renderEditor() {
    var note = state.notes.filter(function (n) { return n.id === state.currentId; })[0];
    var valid = note && note.deleted === (state.view === "trash");
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
      el.editor.hidden = true;
      el.previewPane.hidden = false;
      el.previewPane.innerHTML = renderMarkdown(note.content);
    } else {
      el.editor.hidden = false;
      el.previewPane.hidden = true;
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
    if (!cur || cur.deleted !== (state.view === "trash")) {
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
    var note = { id: uid(), content: "", pinned: false, markdown: false, deleted: false, createdDate: now, modifiedDate: now };
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
        note.deleted = true; note.deletedDate = Date.now(); note.pinned = false;
        state.currentId = null; save(); render(); break;
      case "restore":
        note.deleted = false; note.deletedDate = null; save(); render(); break;
      case "purge":
        state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
        if (state.currentId === note.id) state.currentId = null;
        save(); render(); break;
    }
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
      "<p><b>Markdown：</b>" + (note.markdown ? "已开启" : "未开启") + "　<b>置顶：</b>" + (note.pinned ? "是" : "否") + "</p>";
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
      state.dark = !state.dark;
      store.setItem(DARK_KEY, state.dark ? "1" : "0");
      render();
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
    el.editor.addEventListener("input", function () {
      var note = state.notes.filter(function (n) { return n.id === state.currentId; })[0];
      if (!note || note.deleted) return;
      note.content = el.editor.value;
      note.modifiedDate = Date.now();
      save();
      clearTimeout(debounce);
      debounce = setTimeout(function () { renderList(); renderTags(); }, 250);
    });

    el.infoClose.addEventListener("click", function () { el.infoModal.hidden = true; });
    el.infoModal.addEventListener("click", function (e) {
      if (e.target === el.infoModal) el.infoModal.hidden = true;
    });

    // 编辑器右键菜单（全中文）
    el.editor.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: "撤销", shortcut: "Ctrl+Z", action: function () { el.editor.focus(); document.execCommand("undo"); } },
        { label: "重做", shortcut: "Ctrl+Y", action: function () { el.editor.focus(); document.execCommand("redo"); } },
        { sep: true },
        { label: "插入清单", action: function () { insertChecklist(); } },
        { sep: true },
        { label: "剪切", shortcut: "Ctrl+X", action: function () { document.execCommand("cut"); } },
        { label: "复制", shortcut: "Ctrl+C", action: function () { document.execCommand("copy"); } },
        { label: "粘贴", shortcut: "Ctrl+V", action: function () { document.execCommand("paste"); } },
        { label: "全选", shortcut: "Ctrl+A", action: function () { el.editor.focus(); el.editor.select(); } },
      ]);
    });

    // 点击空白处关闭右键菜单
    document.addEventListener("click", hideCtxMenu);

    el.settingsClose.addEventListener("click", function () { el.settingsModal.hidden = true; });
    el.settingsModal.addEventListener("click", function (e) {
      if (e.target === el.settingsModal) el.settingsModal.hidden = true;
    });
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

    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createNote();
      }
      if (e.key === "Escape" && !el.infoModal.hidden) el.infoModal.hidden = true;
    });
  }

  /* ---------------- 字体设置 ---------------- */
  function applySettings() {
    var stack = state.fontFamily ? '"' + state.fontFamily + '", ' : "";
    stack += '"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Source Han Sans CN",sans-serif';
    document.documentElement.style.setProperty("--font", stack);
    document.documentElement.style.setProperty("--editor-fs", (state.fontSize || 16) + "px");
  }

  function fillFontSelect(fonts) {
    if (!el.fontSelect) return;
    el.fontSelect.innerHTML = "";
    var def = document.createElement("option");
    def.value = "";
    def.textContent = "默认（系统推荐）";
    el.fontSelect.appendChild(def);
    fonts.forEach(function (f) {
      var o = document.createElement("option");
      o.value = f;
      o.textContent = f;
      el.fontSelect.appendChild(o);
    });
    el.fontSelect.value = state.fontFamily || "";
  }

  function openSettings() {
    var fonts = FALLBACK_FONTS.slice();
    if (window.electronAPI && typeof window.electronAPI.getSystemFonts === "function") {
      window.electronAPI.getSystemFonts().then(function (list) {
        if (list && list.length) fonts = list.slice();
        fillFontSelect(fonts);
      }).catch(function () {
        fillFontSelect(fonts);
      });
    } else {
      fillFontSelect(fonts);
    }
    if (el.fontSizeSelect) el.fontSizeSelect.value = String(state.fontSize || 16);
    if (el.fontCustom) el.fontCustom.value = state.fontFamily || "";
    el.settingsModal.hidden = false;
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
    return fetch(url, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!r.ok) throw new Error((data && data.error) ? data.error : "服务器返回错误 (" + r.status + ")");
        return data || {};
      });
    }).catch(function (e) {
      // 网络层失败（连不上/被拦截）时，把技术性的 "Failed to fetch" 换成可操作的中文提示
      if (e && e.message && /failed to fetch|load failed|networkerror/i.test(e.message)) {
        throw new Error("无法连接服务器 " + url + "。请检查：① 地址是否填对（填 IP:端口 即可，会自动补 http://）② 服务端是否已启动 ③ 本机与服务端是否在同一局域网");
      }
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
      createdDate: n.createdDate || Date.now(),
      modifiedDate: n.modifiedDate || Date.now(),
      deletedDate: n.deletedDate || null,
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
  function scheduleSync() {
    if (!state.token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncAll, 1500);
  }
  function syncAll() {
    if (!state.token) return Promise.resolve();
    setSyncStatus("同步中…");
    var payload = { notes: state.notes.map(serializeNote) };
    return api("/api/notes/sync", { method: "POST", body: JSON.stringify(payload) })
      .then(function (res) {
        if (res && res.notes) {
          state.notes = res.notes;
          saveLocalOnly();
          render();
        }
        state.lastSyncTs = Date.now();
        setSyncStatus("已同步 · " + new Date().toLocaleTimeString("zh-CN"));
        return res;
      })
      .catch(function (e) {
        setSyncStatus("同步失败：" + e.message);
      });
  }
  function pullOnly() {
    return api("/api/notes", { method: "GET" }).then(function (res) {
      if (res && res.notes) state.notes = res.notes;
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
      row.className = "ctx-item" + (it.danger ? " danger" : "");
      var lbl = document.createElement("span");
      lbl.textContent = it.label;
      row.appendChild(lbl);
      if (it.shortcut) {
        var sc = document.createElement("span");
        sc.className = "shortcut";
        sc.textContent = it.shortcut;
        row.appendChild(sc);
      }
      row.addEventListener("click", function () {
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
    applySettings();
    bindEvents();
    updateAccountUI();
    if (state.token) {
      setSyncStatus("同步中…");
      pullOnly()
        .then(function () {
          if (state.notes.length === 0) seedIfEmpty();
          saveLocalOnly();
          render();
          setSyncStatus("已同步 · " + new Date().toLocaleTimeString("zh-CN"));
        })
        .catch(function () {
          seedIfEmpty();
          render();
          setSyncStatus("离线（本地可用）");
        });
    } else {
      seedIfEmpty();
      render();
    }
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

    api.getAppVersion().then(function (v) {
      var el = document.getElementById("appVersion");
      if (el) el.textContent = "v" + v;
    });

    var banner = document.getElementById("updateBanner");
    var text = document.getElementById("updateText");
    var dl = document.getElementById("updateDownloadBtn");
    var dismiss = document.getElementById("updateDismissBtn");
    if (!banner) return;

    var releaseUrl = "";
    function showUpdate(info) {
      if (!info || !info.version) return;
      releaseUrl = info.url || "";
      if (text) text.textContent = "发现新版本 v" + info.version;
      banner.hidden = false;
    }

    api.onUpdateAvailable(showUpdate);

    if (dl) {
      dl.addEventListener("click", function () {
        if (releaseUrl && api.openExternal) api.openExternal(releaseUrl);
      });
    }
    if (dismiss) {
      dismiss.addEventListener("click", function () {
        banner.hidden = true;
      });
    }

    // 点击版本徽标 → 手动检查更新
    var badge = document.getElementById("appVersion");
    if (badge && api.checkUpdate) {
      badge.style.cursor = "pointer";
      badge.title = "点击检查更新";
      badge.addEventListener("click", function () {
        badge.textContent = "检查中…";
        api.checkUpdate().then(function () {
          // 更新横幅由 update-available 事件驱动，这里只恢复版本号显示
          api.getAppVersion().then(function (v) {
            badge.textContent = "v" + v;
          });
        });
      });
    }
  }

  init();
})();
