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
        '<button data-action="trash" title="移到回收站">🗑</button>';
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
    el.infoBody.innerHTML =
      "<p><b>创建时间：</b>" + new Date(note.createdDate).toLocaleString("zh-CN") + "</p>" +
      "<p><b>修改时间：</b>" + new Date(note.modifiedDate).toLocaleString("zh-CN") + "</p>" +
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
  function getServerUrl() {
    return (state.serverUrl || "http://localhost:3000").replace(/\/+$/, "");
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
    return fetch(getServerUrl() + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) ? data.error : "请求失败 (" + r.status + ")");
        return data;
      });
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
    if (el.serverUrl) el.serverUrl.value = state.serverUrl || "http://localhost:3000";
    updateAccountUI();
    el.accountModal.hidden = false;
  }
  function doAuth(isRegister) {
    var u = (el.accUser.value || "").trim();
    var p = el.accPass.value || "";
    var server = (el.serverUrl.value || "").trim() || "http://localhost:3000";
    if (!u || !p) { toast("请输入用户名和密码"); return; }
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

  /* ---------------- 初始化 ---------------- */
  function seedIfEmpty() {
    if (state.notes.length === 0) {
      var now = Date.now();
      state.notes.push({
        id: uid(),
        content:
          "欢迎使用简易笔记\n\n这是一个高度还原 Simplenote 的纯中文笔记软件，数据只保存在本机浏览器中。\n\n# 功能一览\n- 三栏布局：标签 / 列表 / 编辑器\n- 搜索、标签（用 #标签 语法）、置顶\n- Markdown 编辑与实时预览\n- 回收站、深色模式、导入导出\n\n**加粗**、*斜体*、`行内代码` 都支持。\n点击顶部工具栏的 M↓ 开启 Markdown，再点 👁 预览。",
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
  }

  init();
})();
