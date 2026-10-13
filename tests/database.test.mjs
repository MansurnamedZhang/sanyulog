import test from "node:test";
import assert from "node:assert/strict";
import {
  createDatabase,
  validateDatabase,
  parseDatabase,
  visibleRows,
  databaseCSV,
  databaseHTML,
  updateProperty,
} from "../static/database-core.mjs";

const id = (n) => n.toString(16).padStart(32, "0");
function fixture() {
  return {
    version: 1,
    title: "实验库",
    columns: [
      { id: id(1), name: "标题", type: "text", options: [] },
      {
        id: id(2),
        name: "状态",
        type: "select",
        options: [
          { id: id(20), label: "待开始", color: "gray" },
          { id: id(21), label: "完成", color: "green" },
        ],
      },
      {
        id: id(3),
        name: "标签",
        type: "multi-select",
        options: [
          { id: id(30), label: "训练", color: "blue" },
          { id: id(31), label: "对照", color: "purple" },
        ],
      },
      { id: id(4), name: "分数", type: "number", options: [] },
      { id: id(5), name: "日期", type: "date", options: [] },
      { id: id(6), name: "验证", type: "checkbox", options: [] },
    ],
    rows: [
      {
        id: id(100),
        values: {
          [id(1)]: "多段\n文字 <script>alert(1)</script>",
          [id(2)]: id(21),
          [id(3)]: [id(30), id(31)],
          [id(4)]: 2,
          [id(5)]: "2026-10-13",
          [id(6)]: true,
        },
      },
      {
        id: id(101),
        values: {
          [id(1)]: "基线",
          [id(2)]: null,
          [id(3)]: [],
          [id(4)]: null,
          [id(5)]: null,
          [id(6)]: false,
        },
      },
    ],
    view: { filter: null, sort: null },
  };
}
test("new database has valid independent JSON", () =>
  assert.doesNotThrow(() => validateDatabase(createDatabase())));
test("strict schema rejects malformed values and foreign IDs", () => {
  assert.deepEqual(parseDatabase(JSON.stringify(fixture())), fixture());
  for (const mutate of [
    (d) => (d.rows[0].values[id(2)] = "unknown"),
    (d) => (d.rows[0].values[id(3)] = [id(30), id(30)]),
    (d) => (d.rows[0].values[id(4)] = "2"),
    (d) => (d.rows[0].values[id(4)] = Infinity),
    (d) => (d.rows[0].values[id(5)] = "2026-02-30"),
    (d) => (d.rows[0].values[id(6)] = 1),
    (d) => (d.columns[1].options[0].color = "url(x)"),
    (d) => (d.columns[1].options[0].color = ["gray"]),
    (d) => (d.columns[1].type = ["select"]),
    (d) => (d.columns[1].options[0].label = "bad\nlabel"),
    (d) => d.columns.push({ ...d.columns[0] }),
    (d) => d.rows.push({ ...d.rows[0] }),
    (d) => (d.rows[0].values.extra = "bad"),
    (d) => (d.view.sort = { column: id(90), direction: "asc" }),
    (d) => (d.view.filter = { column: id(4), operator: "gt", value: "2" }),
    (d) => (d.extra = true),
  ]) {
    const d = fixture();
    mutate(d);
    assert.throws(() => validateDatabase(d));
  }
});
test("views filter typed values, sort numerically with empties last and search labels", () => {
  const d = fixture();
  d.view.filter = { column: id(3), operator: "contains", value: id(30) };
  assert.equal(visibleRows(d).length, 1);
  d.view.filter = null;
  d.rows[1].values[id(4)] = 10;
  d.view.sort = { column: id(4), direction: "asc" };
  assert.equal(visibleRows(d)[0].id, id(100));
  d.view.sort.direction = "desc";
  assert.equal(visibleRows(d)[0].id, id(101));
  d.rows[1].values[id(4)] = null;
  assert.equal(visibleRows(d)[1].id, id(101));
  assert.equal(visibleRows(d, "训练").length, 1);
});
test("choice IDs survive rename, removal cleans values and stale view", () => {
  let d = fixture();
  const col = structuredClone(d.columns[2]);
  col.options[0].label = "新训练";
  d = updateProperty(d, col);
  assert.deepEqual(d.rows[0].values[id(3)], [id(30), id(31)]);
  d.view.filter = { column: id(3), operator: "contains", value: id(30) };
  col.options.shift();
  d = updateProperty(d, col);
  assert.deepEqual(d.rows[0].values[id(3)], [id(31)]);
  assert.equal(d.view.filter, null);
  col.type = "text";
  col.options = [];
  d = updateProperty(d, col);
  assert.equal(d.rows[0].values[id(3)], "");
});
test("exports resolve option labels, retain multiline text, escape HTML and export all rows", () => {
  const d = fixture();
  d.view.filter = { column: id(6), operator: "equals", value: true };
  const csv = databaseCSV(d),
    html = databaseHTML(d);
  assert.match(csv, /训练\n对照/);
  assert.match(csv, /基线/);
  assert.doesNotMatch(csv, new RegExp(id(30)));
  assert.match(html, /训练/);
  assert.match(html, /基线/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /sdb-tag-green/);
});
