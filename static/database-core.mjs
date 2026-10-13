import { newId, escapeHTML as esc, serializeCSV } from "./notebook-core.mjs";

export const propertyTypes = {
  text: "文本",
  select: "单选",
  "multi-select": "多选",
  number: "数字",
  date: "日期",
  checkbox: "复选框",
};
export const propertyIcons = {
  text: "Aa",
  select: "◉",
  "multi-select": "☷",
  number: "#",
  date: "◷",
  checkbox: "☑",
};
export const optionColors = {
  gray: "灰",
  brown: "棕",
  orange: "橙",
  yellow: "黄",
  green: "绿",
  blue: "蓝",
  purple: "紫",
  pink: "粉",
  red: "红",
};
const fail = (message) => {
  throw new Error("数据库：" + message);
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, fields) =>
  object(v) &&
  Object.keys(v).sort().join(",") === fields.slice().sort().join(",");
const identifier = (v) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
const label = (v, max = 80) =>
  typeof v === "string" &&
  !!v.trim() &&
  [...v].length <= max &&
  !/[\r\n\0]/.test(v);
const date = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number(v.slice(0, 4)) >= 1 &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
export const emptyValue = (type) =>
  type === "text"
    ? ""
    : type === "multi-select"
      ? []
      : type === "checkbox"
        ? false
        : null;
export function validValue(column, value) {
  const ids = column.options.map((o) => o.id);
  switch (column.type) {
    case "text":
      return typeof value === "string" && [...value].length <= 20000;
    case "select":
      return value === null || ids.includes(value);
    case "multi-select":
      return (
        Array.isArray(value) &&
        value.every((v) => ids.includes(v)) &&
        new Set(value).size === value.length
      );
    case "number":
      return (
        value === null || (typeof value === "number" && Number.isFinite(value))
      );
    case "date":
      return value === null || date(value);
    case "checkbox":
      return typeof value === "boolean";
    default:
      return false;
  }
}
export function operators(type) {
  const common = [
    ["empty", "为空"],
    ["not-empty", "不为空"],
  ];
  if (type === "checkbox") return [["equals", "等于"]];
  if (type === "number")
    return [["equals", "等于"], ["gt", "大于"], ["lt", "小于"], ...common];
  if (type === "date")
    return [["equals", "等于"], ["gt", "晚于"], ["lt", "早于"], ...common];
  if (type === "select") return [["equals", "是"], ...common];
  if (type === "multi-select") return [["contains", "包含"], ...common];
  return [["contains", "包含"], ["equals", "等于"], ...common];
}
export function validFilter(data, filter) {
  if (filter === null) return true;
  if (!exact(filter, ["column", "operator", "value"])) return false;
  const col = data.columns.find((c) => c.id === filter.column);
  if (!col || !operators(col.type).some(([op]) => op === filter.operator))
    return false;
  if (["empty", "not-empty"].includes(filter.operator))
    return filter.value === null;
  if (col.type === "multi-select")
    return col.options.some((o) => o.id === filter.value);
  return filter.value !== null && validValue(col, filter.value);
}
export function validateDatabase(d) {
  if (
    !exact(d, ["version", "title", "columns", "rows", "view"]) ||
    d.version !== 1 ||
    !label(d.title, 100)
  )
    fail("格式或名称无效");
  if (!Array.isArray(d.columns) || !d.columns.length || d.columns.length > 50)
    fail("需要 1–50 个属性");
  const ids = new Set();
  for (const c of d.columns) {
    if (
      !exact(c, ["id", "name", "type", "options"]) ||
      !identifier(c.id) ||
      ids.has(c.id) ||
      !label(c.name) ||
      typeof c.type !== "string" ||
      !Object.hasOwn(propertyTypes, c.type)
    )
      fail("属性格式或 ID 无效");
    ids.add(c.id);
    if (
      !Array.isArray(c.options) ||
      c.options.length > 100 ||
      (!["select", "multi-select"].includes(c.type) && c.options.length)
    )
      fail("选项无效，最多 100 个");
    const optionIds = new Set(),
      labels = new Set();
    for (const o of c.options) {
      if (
        !exact(o, ["id", "label", "color"]) ||
        !identifier(o.id) ||
        optionIds.has(o.id) ||
        !label(o.label) ||
        o.label !== o.label.trim() ||
        labels.has(o.label) ||
        typeof o.color !== "string" ||
        !Object.hasOwn(optionColors, o.color)
      )
        fail("选项名称、颜色或 ID 无效");
      optionIds.add(o.id);
      labels.add(o.label);
    }
  }
  if (!Array.isArray(d.rows) || d.rows.length > 1000) fail("最多 1000 条记录");
  const rows = new Set();
  for (const r of d.rows) {
    if (
      !exact(r, ["id", "values"]) ||
      !identifier(r.id) ||
      rows.has(r.id) ||
      !exact(r.values, [...ids])
    )
      fail("记录格式或 ID 无效");
    rows.add(r.id);
    for (const c of d.columns)
      if (!validValue(c, r.values[c.id])) fail(c.name + " 的值无效");
  }
  if (!exact(d.view, ["filter", "sort"]) || !validFilter(d, d.view.filter))
    fail("筛选条件无效");
  const sort = d.view.sort;
  if (
    sort !== null &&
    (!exact(sort, ["column", "direction"]) ||
      !ids.has(sort.column) ||
      !["asc", "desc"].includes(sort.direction))
  )
    fail("排序设置无效");
  if (JSON.stringify(d).length > 500000)
    fail("内容最多 500000 字符，请拆分数据库");
  return d;
}
export function parseDatabase(source) {
  let d;
  try {
    d = JSON.parse(source);
  } catch {
    fail("内容不是有效 JSON");
  }
  return validateDatabase(d);
}
export function createDatabase() {
  return {
    version: 1,
    title: "未命名数据库",
    columns: [
      { id: newId(), name: "名称", type: "text", options: [] },
      {
        id: newId(),
        name: "状态",
        type: "select",
        options: [
          ["待开始", "gray"],
          ["进行中", "blue"],
          ["已完成", "green"],
        ].map(([label, color]) => ({ id: newId(), label, color })),
      },
      { id: newId(), name: "标签", type: "multi-select", options: [] },
    ],
    rows: [],
    view: { filter: null, sort: null },
  };
}
export function displayValue(column, value) {
  if (column.type === "select")
    return column.options.find((o) => o.id === value)?.label || "";
  if (column.type === "multi-select")
    return value
      .map((id) => column.options.find((o) => o.id === id)?.label || "")
      .join("\n");
  if (column.type === "checkbox") return value ? "是" : "否";
  return String(value ?? "");
}
export const isEmpty = (value) =>
  value === null || value === "" || (Array.isArray(value) && !value.length);
export function visibleRows(d, search = "") {
  const needle = search.trim().toLocaleLowerCase();
  let rows = d.rows.filter((r) => {
    if (
      needle &&
      !d.columns.some((c) =>
        displayValue(c, r.values[c.id]).toLocaleLowerCase().includes(needle),
      )
    )
      return false;
    const f = d.view.filter;
    if (!f) return true;
    const value = r.values[f.column];
    if (f.operator === "empty") return isEmpty(value);
    if (f.operator === "not-empty") return !isEmpty(value);
    if (f.operator === "equals") return value === f.value;
    if (f.operator === "contains")
      return Array.isArray(value)
        ? value.includes(f.value)
        : value.toLocaleLowerCase().includes(f.value.toLocaleLowerCase());
    if (isEmpty(value)) return false;
    return f.operator === "gt" ? value > f.value : value < f.value;
  });
  if (d.view.sort) {
    const c = d.columns.find((c) => c.id === d.view.sort.column),
      dir = d.view.sort.direction === "asc" ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const av = a.values[c.id],
        bv = b.values[c.id];
      if (isEmpty(av) || isEmpty(bv))
        return Number(isEmpty(av)) - Number(isEmpty(bv));
      if (["number", "checkbox"].includes(c.type))
        return (Number(av) - Number(bv)) * dir;
      return (
        displayValue(c, av).localeCompare(displayValue(c, bv), "zh-CN", {
          numeric: true,
        }) * dir
      );
    });
  }
  return rows;
}
export function updateProperty(data, column) {
  const d = structuredClone(data),
    old = d.columns.find((c) => c.id === column.id);
  if (!old) {
    d.columns.push(column);
    for (const r of d.rows) r.values[column.id] = emptyValue(column.type);
  } else {
    d.columns[d.columns.indexOf(old)] = structuredClone(column);
    for (const r of d.rows) {
      if (old.type !== column.type)
        r.values[column.id] = emptyValue(column.type);
      else if (
        column.type === "select" &&
        !column.options.some((o) => o.id === r.values[column.id])
      )
        r.values[column.id] = null;
      else if (column.type === "multi-select")
        r.values[column.id] = r.values[column.id].filter((id) =>
          column.options.some((o) => o.id === id),
        );
    }
    if (old.type !== column.type && d.view.sort?.column === column.id)
      d.view.sort = null;
  }
  if (!validFilter(d, d.view.filter)) d.view.filter = null;
  return validateDatabase(d);
}
export function databaseCSV(d) {
  return serializeCSV([
    d.columns.map((c) => c.name),
    ...d.rows.map((r) => d.columns.map((c) => displayValue(c, r.values[c.id]))),
  ]);
}
export function tagsHTML(column, value) {
  const ids = column.type === "select" ? [value] : value;
  return ids
    .filter(Boolean)
    .map((id) => {
      const o = column.options.find((o) => o.id === id);
      return o
        ? `<span class="sdb-tag sdb-tag-${o.color}">${esc(o.label)}</span>`
        : "";
    })
    .join("");
}
export function databaseHTML(d) {
  return `<div class="sdb-export"><h3>${esc(d.title)}</h3><table class="nb-export-table"><thead><tr>${d.columns.map((c) => `<th>${esc(c.name)}</th>`).join("")}</tr></thead><tbody>${d.rows.map((r) => `<tr>${d.columns.map((c) => `<td>${["select", "multi-select"].includes(c.type) ? tagsHTML(c, r.values[c.id]) : esc(displayValue(c, r.values[c.id])).replace(/\r?\n/g, "<br>")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
