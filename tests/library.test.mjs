import test from "node:test";
import assert from "node:assert/strict";
import {
  RecordSearch,
  recordExcerpt,
  normalizeView,
} from "../static/library.mjs";

const record = (source = "第一段\n\n第二段") => ({
  id: "demo",
  title: "训练基线",
  goal: "验证细节",
  params: { lr: "0.0001" },
  tags: ["LoRA"],
  result: "",
  conclusion: "",
  next_step: "",
  cells: [{ source }],
  attachments: [{ name: "样本.csv" }],
});

test("library search combines terms across content, metadata and attachments", () => {
  const search = new RecordSearch();
  const item = record();
  assert(search.matches(item, "LORA  第二段 样本.csv"));
  assert(search.matches(item, "0.0001 验证"));
  assert(search.matches(item, "  "));
  assert(!search.matches(item, "LoRA 不存在"));
  assert(search.matches(record('<script>"'), '<script>"'));
});

test("repeated search reuses the index and replacement records refresh it", () => {
  let reads = 0;
  const search = new RecordSearch(),
    item = record();
  Object.defineProperty(item.cells[0], "source", {
    get() {
      reads++;
      return "旧内容";
    },
  });
  for (const q of ["旧", "旧内", "旧内容", "不存在"]) search.matches(item, q);
  assert.equal(reads, 1);
  const replacement = { ...item, cells: [{ source: "更新内容" }] };
  assert(search.matches(replacement, "更新内容"));
  assert(!search.matches(replacement, "旧内容"));
});

test("library excerpts are bounded and preserve readable plain text", () => {
  assert.equal(
    recordExcerpt(record("## 标题\n- **步骤**\n`代码`")),
    "标题 步骤 代码",
  );
  assert(recordExcerpt(record("长文字".repeat(100000))).length <= 160);
  assert.equal(recordExcerpt({ ...record(), cells: [] }), "验证细节");
});

test("view preferences reject unknown values and survive missing storage", () => {
  assert.deepEqual(normalizeView(null), {
    density: "comfortable",
    textSize: "normal",
  });
  assert.deepEqual(normalizeView({ density: "compact", textSize: "large" }), {
    density: "compact",
    textSize: "large",
  });
  assert.deepEqual(
    normalizeView({ density: "unexpected", textSize: -1 }),
    normalizeView(null),
  );
});
