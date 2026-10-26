/* ============ 简易笔记 · 共享核心（单一来源）shared/core.js ============
 * 这里放"三端（桌面 Electron / 移动 Capacitor / 网页版）完全一致"的纯函数，
 * 避免同一段逻辑在 app.js / mobile/www/app.js / server/web/app.js 里各抄一份、
 * 改一处漏两处（tools/parity-check.sh 会强制校验三端一致）。
 *
 * 使用方式：各端 index.html 在 app.js 之前引入本文件，app.js 内部用
 *   var escapeHtml = EZCore.escapeHtml;  // 别名，调用处无需改动
 * 取用这些函数。
 *
 * 平台差异用 configureMarkdown() 注入，不要在这里写平台分支。
 * 生成/校验：tools/build-shared.sh（会把本文件复制到移动端与网页版目录并比对）
 * ============================================================ */
(function (root) {
  "use strict";

  /* ---------- 笔记 id 合法性（与 server/server.js 的校验保持一致）---------- */
  var NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var RESERVED_KEYS = ["__proto__", "constructor", "prototype"];
  function isValidNoteId(id) {
    if (typeof id !== "string" || !NOTE_ID_RE.test(id)) return false;
    // __proto__ / constructor / prototype 会触发原型污染（笔记会"消失"），明确拒绝
    return RESERVED_KEYS.indexOf(id) === -1;
  }

  /* ---------- 转义（HTML 文本 / HTML 属性）---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/"/g, "%22")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* ---------- Markdown 渲染 ----------
   * 平台差异通过钩子注入，默认值 = 移动端/网页版行为：
   *   imgSrc   : 图片地址改写（桌面端把 file:// 改成 easynote-file:// 走主进程读取）
   *   imgTitle : 图片 title 文案
   */
  var mdOpts = {
    imgSrc: function (u) { return u; },
    imgTitle: "点击查看",
  };
  function configureMarkdown(o) {
    if (!o) return;
    if (typeof o.imgSrc === "function") mdOpts.imgSrc = o.imgSrc;
    if (typeof o.imgTitle === "string") mdOpts.imgTitle = o.imgTitle;
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
        var src = mdOpts.imgSrc(url); // 平台钩子：桌面端把 file:// 改写成 easynote-file://
        return '<img class="md-img" alt="' + escapeAttr(alt) + '" src="' + escapeAttr(src) +
          '" title="' + escapeAttr(mdOpts.imgTitle) + '" onerror="this.setAttribute(\'data-missing\',\'1\')">';
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


  /* ---------- 列表标题 / 摘要 / 搜索文本（纯逻辑，三端共用）----------
   * 为什么放在这里：插图后笔记的第一行是 ![名字](data:...) ——
   * 若直接把它当标题，列表里会显示一整串 base64，既难看又影响搜索/导出文件名。
   */
  // 行内 Markdown 剥离：图片整体去掉，链接只留文字，粗体/代码/引用/标题符号去掉
  function stripInlineMd(s) {
    return String(s)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*`>]/g, "")
      .replace(/^#+\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  // 列表标题：跳过"纯图片"行；全篇只有图片时给出友好标题（而不是 base64）
  function noteTitle(content) {
    var text = String(content || "");
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var t = stripInlineMd(lines[i]);
      if (t) return t;
    }
    var imgs = text.match(/!\[[^\]]*\]\([^)]*\)/g);
    if (imgs && imgs.length) {
      var alt = (text.match(/!\[([^\]]*)\]/) || [])[1] || "";
      return alt ? "🖼 " + alt : "🖼 图片笔记";
    }
    return "无标题";
  }
  // 列表摘要：图片替换为 [图片]、链接只留文字；取"标题行之后"的第一段文字，限长 120
  function noteSnippet(content) {
    var raw = String(content || "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    var lines = raw.split("\n");
    var skipped = false;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        if (!skipped) { skipped = true; continue; }
        var s = lines[i].trim();
        return s.length > 120 ? s.slice(0, 120) + "…" : s;
      }
    }
    return "";
  }
  // 搜索用文本：把内嵌图片的 data: 体积部分去掉、保留图片名，
  // 避免搜 "data" 命中所有图片笔记，同时仍然能按图片名搜到。
  function searchText(content) {
    return String(content || "").replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, "$1 [图片] ");
  }

  // 是否"纯图片笔记"：含内嵌图片，且除图片外没有别的文字。
  // 用途：这类笔记打开时直接显示图片预览 —— 否则编辑区是一整屏 base64，
  // 用户看到"一堆字母"，会以为图片没插进去。
  function isImageOnly(content) {
    var c = String(content || "");
    if (!/!\[[^\]]*\]\(data:/.test(c)) return false;
    return !c.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
  }

  root.EZCore = {
    isImageOnly: isImageOnly,
    noteTitle: noteTitle,
    noteSnippet: noteSnippet,
    searchText: searchText,
    isValidNoteId: isValidNoteId,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    inlineMd: inlineMd,
    renderMarkdown: renderMarkdown,
    configureMarkdown: configureMarkdown,
  };
})(typeof window !== "undefined" ? window : this);
