import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../static/notebook-core.mjs";
import { renderNotebookHTML } from "../static/notebook-export.mjs";
import {
  codeLanguages,
  codeLanguage,
  renderCodeBlock,
} from "../static/code-blocks.mjs";
import { highlighter } from "../static/vendor/code-runtime.mjs";

test("language menu grammars and aliases resolve without losing code", () => {
  for (const [language] of codeLanguages)
    assert(highlighter.registered(language), language);
  for (const [alias, expected] of [
    ["py", "python"],
    ["JS", "javascript"],
    ["ts", "typescript"],
    ["sh", "bash"],
    ["yml", "yaml"],
    ["ps1", "powershell"],
    ["c++", "cpp"],
    ["html", "xml"],
  ])
    assert.equal(codeLanguage(alias), expected);
});

test("very large or very long-line code stays complete with bounded highlighting", () => {
  const source = 'print("' + "x".repeat(45000) + '")\n';
  const html = renderCodeBlock(source, "python", { controls: false });
  assert(!html.includes('class="hljs-'));
  assert(html.includes("x".repeat(45000)));
  assert(!html.includes("<button"));
  assert(html.includes("is-wrapped"));
});

test("Markdown code fences retain language and highlight without executing HTML", () => {
  const html = renderMarkdown(
    '```py\ndef train():\n    return "<img src=x onerror=alert(1)>"\n```',
  );
  assert.match(html, /nb-code-block/);
  assert.match(html, /data-code-language="python"/);
  assert.match(html, /hljs-keyword/);
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img/);
});

test("unknown code languages preserve the original text and escape markup", () => {
  for (const language of ["constructor", "__proto__", "toString"]) {
    assert.doesNotThrow(() => renderCodeBlock("  return 1", language));
    assert.equal(codeLanguage(language), language.toLowerCase());
  }
  const html = renderMarkdown(
    "```customlang\n  <script>alert(1)</script>\n  $x^2$\n```",
  );
  assert.match(html, /customlang/);
  assert.match(html, /  &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<math"));
});

test("notebook exports keep language highlighter and original code whitespace", () => {
  const html = renderNotebookHTML({
    title: "代码",
    cells: [{ type: "code", language: "json", source: '{\n  "rank": 32\n}\n' }],
  });
  assert.match(html, /data-code-language="json"/);
  assert.match(html, /hljs-attr/);
  assert.match(html, /32/);
});
