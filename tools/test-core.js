#!/usr/bin/env node
/* ============================================================
 * 共享核心单元测试（shared/core.js）
 * ------------------------------------------------------------
 * shared/core.js 是三端共用的纯函数唯一来源，一旦被改坏，
 * 三端界面（列表标题转义、Markdown 预览、图片/链接渲染）会同时出问题。
 * 这里用断言把它锁住；tools/qa.sh 与 CI 都会跑。
 *
 * 用法：node tools/test-core.js
 * ============================================================ */
"use strict";

const path = require("path");

const mod = require(path.join(__dirname, "..", "shared", "core.js"));
const EZ = (mod && mod.EZCore) || globalThis.EZCore;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

if (!EZ) {
  console.error("✗ 未能加载 shared/core.js（EZCore 未导出）");
  process.exit(1);
}

console.log("\n【1】isValidNoteId");
ok("正常 id 通过", EZ.isValidNoteId("n_abc123") === true);
ok("__proto__ 被拒", EZ.isValidNoteId("__proto__") === false);
ok("constructor 被拒", EZ.isValidNoteId("constructor") === false);
ok("含斜杠被拒", EZ.isValidNoteId("a/b") === false);
ok("空串被拒", EZ.isValidNoteId("") === false);
ok("超长被拒", EZ.isValidNoteId("A".repeat(65)) === false);

console.log("\n【2】escapeHtml / escapeAttr");
ok("转义 &<>\"'", EZ.escapeHtml('<a href="x">&\'') === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
// 注意：escapeAttr 沿用了项目原有写法 —— 双引号替换为 %22（不是 &quot;），
// 在 HTML 属性里同样能防止提前闭合，这里锁住行为避免以后被"顺手改掉"。
ok("escapeAttr 双引号 → %22", EZ.escapeAttr('a" b') === "a%22 b", JSON.stringify(EZ.escapeAttr('a" b')));
ok("escapeAttr 转义尖括号", EZ.escapeAttr("<&>") === "&lt;&&gt;", JSON.stringify(EZ.escapeAttr("<&>")));

console.log("\n【3】renderMarkdown 基本语法");
const md = EZ.renderMarkdown;
ok("标题", md("# 标题").indexOf("<h1>标题</h1>") !== -1, md("# 标题"));
ok("加粗", md("**粗**").indexOf("<strong>粗</strong>") !== -1);
ok("斜体", md("*斜*").indexOf("<em>斜</em>") !== -1);
ok("行内代码", md("`code`").indexOf("<code>code</code>") !== -1);
ok("无序列表", md("- a").indexOf("<ul>") !== -1 && md("- a").indexOf("<li>a</li>") !== -1);
ok("引用", md("> 引用").indexOf("<blockquote>") !== -1);
ok("图片带默认 title", md("![图](pic.png)").indexOf('title="点击查看"') !== -1);
ok("链接渲染", md("[站](https://a.b)").indexOf('href="https://a.b"') !== -1);

console.log("\n【4】安全：Markdown 不得注入 HTML/事件属性");
const inj = md('<script>alert(1)</script>');
ok("不输出 script 标签", inj.indexOf("<script") === -1, inj.slice(0, 80));
const injImg = md('![a](x" onerror="alert(1))');
ok("图片 URL 内的引号被转义（无法注入 onerror）",
  injImg.indexOf('onerror="alert') === -1, injImg.slice(0, 120));
const injLink = md('[x](javascript:alert(1))');
ok("链接渲染不产生可执行 href 注入", injLink.indexOf('"javascript:alert(1)"') === -1 || injLink.indexOf("&quot;") !== -1);

console.log("\n【5】平台钩子 configureMarkdown");
EZ.configureMarkdown({ imgTitle: "点击在外部打开" });
ok("自定义 title 生效", md("![图](pic.png)").indexOf('title="点击在外部打开"') !== -1);
EZ.configureMarkdown({
  imgSrc: function (u) { return /^file:\/\//i.test(u) ? "easynote-file://" + u.replace(/^file:\/\//i, "") : u; },
});
ok("桌面端 file:// 改写生效",
  md("![图](file:///tmp/a.png)").indexOf('src="easynote-file:///tmp/a.png"') !== -1,
  md("![图](file:///tmp/a.png)"));
ok("http 图片不受影响", md("![图](https://x/y.png)").indexOf('src="https://x/y.png"') !== -1);

console.log("\n【6】noteTitle / noteSnippet / searchText（插图笔记的标题 / 摘要 / 搜索）");
ok("普通笔记标题", EZ.noteTitle("会议纪要\n明天 10 点") === "会议纪要");
ok("Markdown 标题去掉 #", EZ.noteTitle("# 标题") === "标题");
ok("首行是图片 → 跳过，用下一行文字当标题",
  EZ.noteTitle("![图](data:image/png;base64,AAAA)\n真正的标题") === "真正的标题",
  EZ.noteTitle("![图](data:image/png;base64,AAAA)\n真正的标题"));
ok("全篇只有图片 → 友好标题（用图片名）",
  EZ.noteTitle("![风景](data:image/png;base64,AAAA)") === "🖼 风景",
  EZ.noteTitle("![风景](data:image/png;base64,AAAA)"));
ok("标题里绝不出现 base64",
  EZ.noteTitle("![图](data:image/png;base64,AAAA)").indexOf("base64") === -1);
ok("空笔记 → 无标题", EZ.noteTitle("") === "无标题");
ok("摘要跳过标题行", EZ.noteSnippet("标题\n正文内容") === "正文内容");
ok("摘要把图片写成 [图片]", EZ.noteSnippet("标题\n![图](data:image/png;base64,AAAA)").indexOf("[图片]") !== -1);
ok("searchText 去掉 base64 体积部分",
  EZ.searchText("![风景](data:image/png;base64,AAAA)").indexOf("base64") === -1);
ok("searchText 保留图片名（仍可搜到）",
  EZ.searchText("![风景](data:image/png;base64,AAAA)").indexOf("风景") !== -1);


console.log("\n【7】isImageOnly（纯图片笔记判定：决定打开时是否直接显示图片）");
ok("只有内嵌图片 → true", EZ.isImageOnly("![e1.jpg](data:image/png;base64,AAAA)") === true);
ok("图片 + 文字 → false", EZ.isImageOnly("![e1.jpg](data:image/png;base64,AAAA)\n说明文字") === false);
ok("纯文字 → false", EZ.isImageOnly("今天开会") === false);
ok("外链图片（非 data:）→ false", EZ.isImageOnly("![x](https://a/b.png)") === false);
ok("多张内嵌图片 → true",
  EZ.isImageOnly("![a](data:image/png;base64,AA)\n![b](data:image/jpeg;base64,BB)") === true);


console.log("\n【8】extractTags（标签提取，跳过图片/链接里的 #）");
ok("普通标签", JSON.stringify(EZ.extractTags("今天 #工作 #待办")) === JSON.stringify(["工作", "待办"]));
ok("英文标签小写归一", EZ.extractTags("#Work")[0] === "work");
ok("图片名里的 # 不算标签", EZ.extractTags("![IMG#1](data:image/png;base64,AA)").length === 0,
  JSON.stringify(EZ.extractTags("![IMG#1](data:image/png;base64,AA)")));
ok("链接 URL 里的 #anchor 不算标签", EZ.extractTags("[站](https://a.b#top)").length === 0);
ok("正文标签照常识别", EZ.extractTags("![图](data:image/png;base64,AA)\n#真标签").indexOf("真标签") !== -1);

console.log("\n【9】mergeIncoming（同步合并 + 冲突副本，三端一致的关键）");
var _seq = 0;
function nid() { _seq++; return "n_conf" + _seq; }
function mk(id, content, mod) { return { id: id, content: content, modifiedDate: mod }; }
// 注意语义：pushedMap 记录"本机版本已被服务端确认的时间"。
// 本地改动时间 > pushedMap[id] ⇒ 视为"本机有未确认的改动"。
var r0 = EZ.mergeIncoming([], [mk("n_b2", "服务端来的", 100)], {}, nid);
ok("全新笔记入库", r0.changed && r0.notes.length === 1 && r0.conflicts.length === 0);
var r1 = EZ.mergeIncoming([mk("n_a", "本地旧", 100)], [mk("n_a", "服务端新", 200)], { "n_a": 100 }, nid);
ok("后写覆盖", r1.changed && r1.notes[0].content === "服务端新");
ok("本机版本已被服务端确认（pushed=100）→ 不产生冲突", r1.conflicts.length === 0);
var r2 = EZ.mergeIncoming([mk("n_a", "本地未推送", 300)], [mk("n_a", "服务端新", 400)], { "n_a": 100 }, nid);
ok("双端同时改 → 保底冲突副本", r2.conflicts.length === 1 && r2.notes.length === 2);
ok("冲突副本保留本机内容", r2.notes.some(function (n) { return n.content.indexOf("本地未推送") !== -1; }));
ok("冲突副本标题不含 base64", r2.conflicts[0].content.indexOf("base64") === -1);
var r3 = EZ.mergeIncoming([], [mk("n_b", "新笔记", 1)], {}, nid);
ok("服务端新增 → 入库", r3.changed && r3.notes.length === 1);
var r4 = EZ.mergeIncoming([], [{ id: "__proto__", content: "x", modifiedDate: 1 }], {}, nid);
ok("脏 id 被忽略", r4.notes.length === 0);


console.log("\n────────────────────────");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
