import { newId, escapeHTML as esc } from "./notebook-core.mjs";
import { copyCodeText } from "./code-blocks.mjs";
import {
  createDatabase,
  parseDatabase,
  validateDatabase,
  emptyValue,
  propertyTypes,
  propertyIcons,
  optionColors,
  operators,
  visibleRows,
  databaseCSV,
  tagsHTML,
  updateProperty,
  isEmpty,
} from "./database-core.mjs";

const $ = (s, r) => r.querySelector(s),
  $$ = (s, r) => [...r.querySelectorAll(s)];
const button = (action, text, extra = "") =>
  `<button type="button" data-db="${action}" ${extra}>${text}</button>`;
const options = (items, value) =>
  items
    .map(
      ([id, name]) =>
        `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(name)}</option>`,
    )
    .join("");
const pageSize = 50;

export class DatabaseUI {
  constructor(nb) {
    this.nb = nb;
    this.states = new Map();
    this.dialogs = new Set();
    this.widths = new WeakMap();
    this.observer = new ResizeObserver((entries) => {
      for (const { target, contentRect } of entries)
        if (
          target.isConnected &&
          contentRect.width !== this.widths.get(target)
        ) {
          this.widths.set(target, contentRect.width);
          this.fit(target);
        }
    });
    nb.controller.signal.addEventListener("abort", () => this.dispose(), {
      once: true,
    });
  }
  dispose() {
    this.observer.disconnect();
    for (const d of [...this.dialogs]) {
      d.close();
      d.remove();
    }
    this.dialogs.clear();
  }
  state(id) {
    if (!this.states.has(id))
      this.states.set(id, { page: 0, search: "", selected: new Set() });
    return this.states.get(id);
  }
  freezeView(id) {
    const state = this.state(id),
      d = this.data(id);
    if ((d.view.filter || d.view.sort || state.search) && !state.frozenRows)
      state.frozenRows = visibleRows(d, state.search).map((r) => r.id);
  }
  data(id) {
    const cell = this.nb.cell(id);
    if (!cell || cell.type !== "database") throw new Error("数据库块已移除");
    return parseDatabase(cell.source);
  }
  save(id, data) {
    validateDatabase(data);
    const current = this.nb.cell(id);
    if (!current || current.type !== "database")
      throw new Error("数据库块已移除");
    // Autosave clones cells; always update the current snapshot by ID.
    const cell = { ...current, source: JSON.stringify(data) };
    this.nb.queue.change({
      cells: this.nb.queue.data.cells.map((c) => (c.id === id ? cell : c)),
    });
  }
  mutate(id, fn, render = true) {
    const data = this.data(id);
    fn(data);
    this.save(id, data);
    if (render) this.render(id);
  }
  html(cell) {
    try {
      return this.content(cell.id, this.dataFromCell(cell));
    } catch (e) {
      return `<div class="sdb sdb-error"><b>数据库暂时无法显示</b><p>${esc(e.message)}</p><p>原内容仍保留，请下载笔记草稿检查。</p></div>`;
    }
  }
  dataFromCell(cell) {
    return parseDatabase(cell.source);
  }
  content(id, d) {
    const state = this.state(id),
      rows = state.frozenRows
        ? state.frozenRows
            .map((id) => d.rows.find((r) => r.id === id))
            .filter(Boolean)
        : visibleRows(d, state.search);
    state.page = Math.min(
      state.page,
      Math.max(0, Math.ceil(rows.length / pageSize) - 1),
    );
    const pageRows = rows.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    );
    for (const selected of state.selected)
      if (!d.rows.some((r) => r.id === selected))
        state.selected.delete(selected);
    const selected = state.selected.size;
    return `<div class="sdb" data-db-id="${id}">
      <div class="sdb-heading"><div><input data-db-title aria-label="数据库名称" maxlength="100" value="${esc(d.title)}"><p>表格视图 <span>· ${d.columns.length} 个属性 · ${d.rows.length} 条记录</span></p></div>${button("add-row", "＋ 新建记录", 'class="sdb-primary"')}</div>
      <div class="sdb-toolbar" role="toolbar" aria-label="数据库工具"><span class="sdb-view-label">▤ 表格</span><input data-db-search type="search" aria-label="搜索数据库" placeholder="搜索记录或标签" value="${esc(state.search)}">${button("filter", "筛选" + (d.view.filter ? " · 1" : ""), `aria-pressed="${!!d.view.filter}"`)}${button("sort", "排序" + (d.view.sort ? " · 1" : ""), `aria-pressed="${!!d.view.sort}"`)}${button("properties", "属性")}${button("export", "导出 CSV", 'class="sdb-export-button"')}</div>
      ${d.view.filter || d.view.sort || state.frozenRows ? `<div class="sdb-view-summary"><span>${d.view.filter ? this.filterLabel(d) : ""}${d.view.filter && d.view.sort ? " · " : ""}${d.view.sort ? esc(d.columns.find((c) => c.id === d.view.sort.column).name) + (d.view.sort.direction === "asc" ? " 升序" : " 降序") : ""}</span>${state.frozenRows ? button("refresh-view", "刷新视图", 'title="应用编辑后的筛选和排序，编辑时保持行位置"') : ""}${button("clear-view", "清除视图条件")}</div>` : ""}
      ${selected ? `<div class="sdb-selection"><span>已选择 ${selected} 条记录</span>${button("copy", "复制选中")}${button("delete-selected", "删除选中", 'class="sdb-danger"')}${button("clear-selection", "取消选择")}</div>` : ""}
      <div class="sdb-scroll" tabindex="0" aria-label="数据库表格，可横向滚动"><table class="sdb-grid"><colgroup><col class="sdb-col-select">${d.columns.map((c) => `<col class="sdb-col-${c.type}">`).join("")}<col class="sdb-col-actions"></colgroup><thead><tr><th><input type="checkbox" data-db-select-all aria-label="选择本页全部记录" ${pageRows.length && pageRows.every((r) => state.selected.has(r.id)) ? "checked" : ""} ${pageRows.length ? "" : "disabled"}></th>${d.columns.map((c) => `<th>${button("property", `<span aria-hidden="true">${propertyIcons[c.type]}</span> ${esc(c.name)} <span aria-hidden="true">⌄</span>`, `data-column="${c.id}" title="编辑属性：${esc(c.name)}"`)}</th>`).join("")}<th>${button("add-property", "＋", 'aria-label="添加属性"')}</th></tr></thead><tbody>
      ${pageRows.map((r) => `<tr data-db-record="${r.id}" class="${state.selected.has(r.id) ? "sdb-selected" : ""}"><td><input type="checkbox" data-db-select-row data-row="${r.id}" aria-label="选择记录 ${esc(d.columns[0].type === "text" ? r.values[d.columns[0].id] || "未命名" : r.id)}" ${state.selected.has(r.id) ? "checked" : ""}></td>${d.columns.map((c) => this.valueHTML(c, r)).join("")}<td class="sdb-record-actions">${button("duplicate-row", "⧉", `data-row="${r.id}" aria-label="复制此记录"`)}${button("delete-row", "×", `data-row="${r.id}" aria-label="删除此记录"`)}</td></tr>`).join("")}
      </tbody></table>${!rows.length ? `<div class="sdb-empty"><b>${d.rows.length ? "没有符合条件的记录" : "从第一条记录开始"}</b><p>${d.rows.length ? "调整筛选或搜索，显示更多记录。" : "点击「新建记录」填写内容；点击列标题设置属性。"}${d.rows.length ? button("clear-view", "清除筛选和搜索") : button("add-row", "＋ 新建记录")}</p></div>` : ""}</div>
      <div class="sdb-footer"><span>显示 ${rows.length ? state.page * pageSize + 1 : 0}–${Math.min((state.page + 1) * pageSize, rows.length)} / ${rows.length} 条${rows.length !== d.rows.length ? ` · 全部 ${d.rows.length} 条` : ""}</span><div>${button("prev", "上一页", state.page === 0 ? "disabled" : "")}<span>${state.page + 1} / ${Math.max(1, Math.ceil(rows.length / pageSize))}</span>${button("next", "下一页", (state.page + 1) * pageSize >= rows.length ? "disabled" : "")}</div></div>
    </div>`;
  }
  valueHTML(c, r) {
    const value = r.values[c.id],
      attrs = `data-db-input data-row="${r.id}" data-column="${c.id}" aria-label="${esc(c.name)}"`;
    let html;
    if (c.type === "text")
      html = `<textarea ${attrs} rows="1" maxlength="20000" placeholder="空" spellcheck="false">${esc(value)}</textarea>`;
    else if (c.type === "checkbox")
      html = `<input type="checkbox" ${attrs} ${value ? "checked" : ""}>`;
    else if (c.type === "number")
      html = `<input type="number" ${attrs} step="any" placeholder="空" value="${value ?? ""}">`;
    else if (c.type === "date")
      html = `<input type="date" ${attrs} min="0001-01-01" max="9999-12-31" value="${value ?? ""}">`;
    else
      html = button(
        "choose",
        tagsHTML(c, value) || '<span class="sdb-placeholder">选择…</span>',
        `class="sdb-choice-cell" data-row="${r.id}" data-column="${c.id}" aria-label="选择${esc(c.name)}"`,
      );
    return `<td class="sdb-value sdb-value-${c.type}">${html}</td>`;
  }
  filterLabel(d) {
    const f = d.view.filter,
      c = d.columns.find((c) => c.id === f.column);
    const op = operators(c.type).find(([id]) => id === f.operator)[1];
    let value = f.value ?? "";
    if (["select", "multi-select"].includes(c.type))
      value = c.options.find((o) => o.id === f.value)?.label || "";
    if (c.type === "checkbox") value = f.value ? "已勾选" : "未勾选";
    return esc(c.name + " " + op + (value !== "" ? " " + value : ""));
  }
  scrollSnapshot(el) {
    const entries = [];
    for (let node = el; node; node = node.parentElement)
      entries.push([node, node.scrollTop, node.scrollLeft]);
    entries.push([
      document.scrollingElement,
      document.scrollingElement.scrollTop,
      document.scrollingElement.scrollLeft,
    ]);
    return () => {
      for (const [node, top, left] of entries)
        if (node?.isConnected) {
          node.scrollTop = top;
          node.scrollLeft = left;
        }
    };
  }
  mount() {
    this.observer.disconnect();
    for (const el of $$(".sdb-scroll", this.nb.root)) {
      this.fit(el);
      this.observer.observe(el);
    }
  }
  fit(root) {
    for (const area of $$("textarea[data-db-input]", root)) {
      area.style.height = "0px";
      area.style.height = Math.max(40, area.scrollHeight + 2) + "px";
    }
  }
  render(id) {
    const host = $(`[data-db-id="${id}"]`, this.nb.root);
    if (!host) return;
    const scroll = $(".sdb-scroll", host),
      top = scroll?.scrollTop,
      left = scroll?.scrollLeft;
    const restore = this.scrollSnapshot(host),
      active = document.activeElement;
    let selector = null,
      selection = null;
    if (host.contains(active)) {
      if (active.matches("[data-db-search]")) selector = "[data-db-search]";
      else if (active.matches("[data-db-title]")) selector = "[data-db-title]";
      else if (active.dataset.row && active.dataset.column)
        selector = `[data-row="${active.dataset.row}"][data-column="${active.dataset.column}"]`;
      if (typeof active.selectionStart === "number")
        selection = [active.selectionStart, active.selectionEnd];
    }
    host.outerHTML = this.content(id, this.data(id));
    const fresh = $(`[data-db-id="${id}"]`, this.nb.root);
    this.mount();
    const newScroll = $(".sdb-scroll", fresh);
    newScroll.scrollTop = top || 0;
    newScroll.scrollLeft = left || 0;
    if (selector) {
      const focus = $(selector, fresh);
      focus?.focus({ preventScroll: true });
      if (selection) focus?.setSelectionRange?.(...selection);
    }
    restore();
  }
  input(event) {
    const el = event.target,
      host = el.closest("[data-db-id]");
    if (!host) return false;
    const id = host.dataset.dbId;
    if (el.matches("[data-db-search]")) {
      this.state(id).search = el.value;
      this.state(id).page = 0;
      this.state(id).frozenRows = null;
      this.render(id);
    } else if (el.matches("[data-db-title]")) {
      if (el.value.trim()) this.mutate(id, (d) => (d.title = el.value), false);
    } else if (el.matches("[data-db-input]") && el.type !== "checkbox") {
      if (!el.checkValidity()) return true;
      const d = this.data(id),
        c = d.columns.find((c) => c.id === el.dataset.column);
      const value =
        c.type === "number"
          ? el.value === ""
            ? null
            : Number(el.value)
          : c.type === "date"
            ? el.value || null
            : el.value;
      try {
        this.freezeView(id);
        this.mutate(
          id,
          (data) =>
            (data.rows.find((r) => r.id === el.dataset.row).values[c.id] =
              value),
          false,
        );
      } catch (e) {
        this.nb.toast(e.message, true);
        el.value =
          d.rows.find((r) => r.id === el.dataset.row).values[c.id] ?? "";
      }
      if (el.tagName === "TEXTAREA") this.fit(el.closest("tr"));
    }
    return true;
  }
  change(event) {
    const el = event.target,
      host = el.closest("[data-db-id]");
    if (!host) return false;
    const id = host.dataset.dbId,
      state = this.state(id);
    if (el.matches("[data-db-select-row]")) {
      if (el.checked) state.selected.add(el.dataset.row);
      else state.selected.delete(el.dataset.row);
      this.render(id);
    } else if (el.matches("[data-db-select-all]")) {
      const rows = visibleRows(this.data(id), state.search).slice(
        state.page * pageSize,
        (state.page + 1) * pageSize,
      );
      for (const r of rows) {
        if (el.checked) state.selected.add(r.id);
        else state.selected.delete(r.id);
      }
      this.render(id);
    } else if (el.matches("[data-db-input]")) {
      if (el.type === "checkbox") {
        this.freezeView(id);
        this.mutate(
          id,
          (d) =>
            (d.rows.find((r) => r.id === el.dataset.row).values[
              el.dataset.column
            ] = el.checked),
          false,
        );
      } else if (!el.checkValidity()) {
        const d = this.data(id);
        el.value =
          d.rows.find((r) => r.id === el.dataset.row).values[
            el.dataset.column
          ] ?? "";
        this.nb.toast("请输入有效的数字或日期", true);
      }
      if (state.frozenRows) {
        const summary = $(".sdb-view-summary", host);
        if (summary && !$('[data-db="refresh-view"]', summary))
          summary.insertAdjacentHTML(
            "beforeend",
            button("refresh-view", "刷新视图"),
          );
        else if (!summary)
          host.insertAdjacentHTML(
            "afterbegin",
            '<div class="sdb-view-summary"><span>编辑时保持记录位置</span>' +
              button("refresh-view", "刷新视图") +
              "</div>",
          );
      }
    } else if (el.matches("[data-db-title]") && !el.value.trim())
      el.value = this.data(id).title;
    return true;
  }
  async click(event) {
    const el = event.target.closest("[data-db]"),
      host = el?.closest("[data-db-id]");
    if (!host) return false;
    const id = host.dataset.dbId,
      action = el.dataset.db,
      state = this.state(id);
    this.nb.setActive(id);
    if (action === "add-row") {
      state.frozenRows = null;
      this.mutate(id, (d) => {
        if (d.rows.length >= 1000) throw new Error("数据库最多 1000 条记录");
        d.rows.push({
          id: newId(),
          values: Object.fromEntries(
            d.columns.map((c) => [c.id, emptyValue(c.type)]),
          ),
        });
      });
      if (this.data(id).view.filter || state.search)
        this.nb.toast("记录已创建；清除筛选和搜索可查看新记录");
    } else if (action === "duplicate-row")
      this.mutate(id, (d) => {
        if (d.rows.length >= 1000) throw new Error("数据库最多 1000 条记录");
        const index = d.rows.findIndex((r) => r.id === el.dataset.row);
        d.rows.splice(index + 1, 0, {
          ...structuredClone(d.rows[index]),
          id: newId(),
        });
      });
    else if (action === "delete-row" || action === "delete-selected") {
      const ids =
        action === "delete-row"
          ? new Set([el.dataset.row])
          : new Set(state.selected);
      if (
        confirm(
          `删除 ${ids.size} 条数据库记录？此操作会删除这些记录的全部属性值。`,
        )
      ) {
        this.mutate(id, (d) => (d.rows = d.rows.filter((r) => !ids.has(r.id))));
        state.selected.clear();
        this.render(id);
      }
    } else if (action === "clear-selection") {
      state.selected.clear();
      this.render(id);
    } else if (action === "prev" || action === "next") {
      state.page += action === "next" ? 1 : -1;
      state.frozenRows = null;
      this.render(id);
    } else if (action === "refresh-view") {
      state.frozenRows = null;
      this.render(id);
    } else if (action === "clear-view") {
      state.page = 0;
      state.search = "";
      state.frozenRows = null;
      this.mutate(id, (d) => (d.view = { filter: null, sort: null }));
    } else if (action === "add-property" || action === "property")
      this.propertyDialog(id, el.dataset.column, el);
    else if (action === "properties") this.propertiesDialog(id, el);
    else if (action === "choose")
      this.choiceDialog(id, el.dataset.row, el.dataset.column, el);
    else if (action === "filter" || action === "sort")
      this.viewDialog(id, action, el);
    else if (action === "copy") {
      const d = this.data(id);
      d.rows = d.rows.filter((r) => state.selected.has(r.id));
      await copyCodeText(databaseCSV(d));
      this.nb.toast("已复制选中记录（含属性名称）");
    } else if (action === "export") {
      const d = this.data(id),
        url = URL.createObjectURL(
          new Blob(["\ufeff" + databaseCSV(d)], {
            type: "text/csv;charset=utf-8",
          }),
        ),
        a = document.createElement("a");
      a.href = url;
      a.download = d.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") + ".csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.nb.toast(
        "已导出全部记录；CSV 保存可读文本，完整属性结构保留在账号备份中",
      );
    }
    return true;
  }
  dialog(className, html, anchor, onClose) {
    const restore = this.scrollSnapshot(anchor),
      d = document.createElement("dialog");
    d.className = "sdb-dialog " + className;
    d.innerHTML = html;
    document.body.append(d);
    this.dialogs.add(d);
    d.addEventListener(
      "close",
      () => {
        this.dialogs.delete(d);
        d.remove();
        restore();
        if (anchor.isConnected) anchor.focus({ preventScroll: true });
        onClose?.();
      },
      { once: true },
    );
    d.addEventListener("click", (e) => {
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          d.close();
      }
    });
    d.showModal();
    restore();
    return d;
  }
  error(d, e) {
    $("[data-dialog-error]", d).textContent = e.message;
  }
  propertyDialog(id, columnId, anchor, onSaved) {
    const initial = this.data(id),
      old = initial.columns.find((c) => c.id === columnId);
    if (!old && initial.columns.length >= 50) {
      this.nb.toast("最多 50 个属性", true);
      return;
    }
    const draft = old
      ? structuredClone(old)
      : { id: newId(), name: "新属性", type: "text", options: [] };
    const d = this.dialog(
      "sdb-property-dialog",
      `<form><div class="sdb-dialog-heading"><h3>${old ? "编辑属性" : "添加属性"}</h3><span>定义这一列的内容</span></div><label>属性名称<input name="name" maxlength="80" required value="${esc(draft.name)}"></label><label>属性类型<select name="type">${options(Object.entries(propertyTypes), draft.type)}</select></label><p class="sdb-hint">更改类型会清空该属性的值；属性改名不会影响记录。</p><div data-option-editor></div><p class="sdb-dialog-error" data-dialog-error role="alert"></p><footer><button type="button" data-prop="cancel">取消</button><button type="submit" class="sdb-primary">保存属性</button></footer></form>`,
      anchor,
      onSaved,
    );
    const editor = $("[data-option-editor]", d);
    const renderOptions = () => {
      const show = ["select", "multi-select"].includes(draft.type);
      editor.hidden = !show;
      editor.innerHTML = `<div class="sdb-options-heading"><b>选项</b><button type="button" data-prop="add-option" ${draft.options.length >= 100 ? "disabled" : ""}>＋ 添加选项</button></div><div class="sdb-option-list">${draft.options.map((o, i) => `<div class="sdb-option-row"><span class="sdb-color-dot sdb-tag-${o.color}"></span><input data-option-label data-index="${i}" maxlength="80" aria-label="选项名称" value="${esc(o.label)}"><select data-option-color data-index="${i}" aria-label="选项颜色">${options(Object.entries(optionColors), o.color)}</select><button type="button" data-prop="remove-option" data-index="${i}" aria-label="移除选项">×</button></div>`).join("")}</div><p class="sdb-hint">移除已使用的选项会同时移除记录中的该选择。</p>`;
    };
    renderOptions();
    d.addEventListener("input", (e) => {
      if (e.target.matches("[data-option-label]"))
        draft.options[Number(e.target.dataset.index)].label = e.target.value;
    });
    d.addEventListener("change", (e) => {
      if (e.target.name === "type") {
        draft.type = e.target.value;
        renderOptions();
      }
      if (e.target.matches("[data-option-color]")) {
        draft.options[Number(e.target.dataset.index)].color = e.target.value;
        const row = e.target.closest(".sdb-option-row");
        $(".sdb-color-dot", row).className =
          "sdb-color-dot sdb-tag-" + e.target.value;
      }
    });
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-prop]");
      if (!b) return;
      if (b.dataset.prop === "cancel") d.close();
      if (b.dataset.prop === "add-option" && draft.options.length < 100) {
        draft.options.push({ id: newId(), label: "", color: "gray" });
        renderOptions();
        $$("[data-option-label]", d).at(-1).focus({ preventScroll: true });
      }
      if (b.dataset.prop === "remove-option") {
        draft.options.splice(Number(b.dataset.index), 1);
        renderOptions();
      }
    });
    $("form", d).addEventListener("submit", (e) => {
      e.preventDefault();
      try {
        draft.name = $('[name="name"]', d).value.trim();
        draft.type = $('[name="type"]', d).value;
        const next = {
          ...draft,
          options: ["select", "multi-select"].includes(draft.type)
            ? draft.options.map((o) => ({ ...o, label: o.label.trim() }))
            : [],
        };
        const data = this.data(id),
          current = data.columns.find((c) => c.id === columnId),
          updated = updateProperty(data, next);
        if (current) {
          const affected = data.rows.filter(
            (r) =>
              JSON.stringify(r.values[current.id]) !==
                JSON.stringify(
                  updated.rows.find((n) => n.id === r.id).values[current.id],
                ) && !isEmpty(r.values[current.id]),
          ).length;
          if (
            affected &&
            !confirm(
              `此变更将清空或移除 ${affected} 条记录中的属性值，继续保存？`,
            )
          )
            return;
        }
        this.state(id).frozenRows = null;
        this.save(id, updated);
        this.render(id);
        d.close();
      } catch (error) {
        this.error(d, error);
      }
    });
    $('[name="name"]', d).select();
  }
  propertiesDialog(id, anchor) {
    const d = this.dialog(
      "sdb-properties-dialog",
      `<h3>数据库属性</h3><p class="sdb-hint">修改名称、类型和选项，或调整列顺序。</p><div data-properties-list></div><p class="sdb-dialog-error" data-dialog-error role="alert"></p><footer><button type="button" data-prop="add">＋ 添加属性</button><button type="button" data-prop="done" class="sdb-primary">完成</button></footer>`,
      anchor,
    );
    const render = () => {
      $("[data-properties-list]", d).innerHTML = this.data(id)
        .columns.map(
          (c, i, all) =>
            `<div class="sdb-property-row" data-column="${c.id}"><span class="sdb-property-icon">${propertyIcons[c.type]}</span><button type="button" data-prop="edit" class="sdb-property-name">${esc(c.name)}<small>${propertyTypes[c.type]}</small></button><button type="button" data-prop="left" aria-label="属性左移" ${i === 0 ? "disabled" : ""}>←</button><button type="button" data-prop="right" aria-label="属性右移" ${i === all.length - 1 ? "disabled" : ""}>→</button><button type="button" data-prop="delete" class="sdb-danger" aria-label="删除属性" ${all.length === 1 ? "disabled" : ""}>×</button></div>`,
        )
        .join("");
    };
    render();
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-prop]");
      if (!b) return;
      const action = b.dataset.prop,
        colId = b.closest("[data-column]")?.dataset.column;
      try {
        if (action === "done") d.close();
        else if (action === "add" || action === "edit")
          this.propertyDialog(id, colId, b, () => {
            if (d.isConnected) render();
          });
        else if (action === "left" || action === "right") {
          this.mutate(id, (data) => {
            const i = data.columns.findIndex((c) => c.id === colId),
              j = i + (action === "left" ? -1 : 1);
            if (j >= 0 && j < data.columns.length)
              [data.columns[i], data.columns[j]] = [
                data.columns[j],
                data.columns[i],
              ];
          });
          render();
        } else if (action === "delete") {
          const data = this.data(id),
            c = data.columns.find((c) => c.id === colId);
          if (data.columns.length <= 1) return;
          if (confirm(`删除属性「${c.name}」及所有记录中的这一列？`)) {
            this.mutate(id, (data) => {
              data.columns = data.columns.filter((c) => c.id !== colId);
              for (const r of data.rows) delete r.values[colId];
              if (data.view.filter?.column === colId) data.view.filter = null;
              if (data.view.sort?.column === colId) data.view.sort = null;
            });
            render();
          }
        }
      } catch (error) {
        this.error(d, error);
      }
    });
  }
  choiceDialog(id, rowId, columnId, anchor) {
    const column = this.data(id).columns.find((c) => c.id === columnId);
    const multi = column.type === "multi-select";
    const d = this.dialog(
      "sdb-picker",
      `<h3>${esc(column.name)} <small>${multi ? "可选择多个" : "选择一个"}</small></h3><input data-choice-search type="search" maxlength="80" placeholder="搜索或创建选项" aria-label="搜索或创建选项"><div data-choice-list></div><p class="sdb-dialog-error" data-dialog-error role="alert"></p><footer><button type="button" data-choice="clear">清空选择</button><button type="button" data-choice="done" class="sdb-primary">完成选择</button></footer>`,
      anchor,
    );
    const render = () => {
      const data = this.data(id),
        c = data.columns.find((c) => c.id === columnId),
        value = data.rows.find((r) => r.id === rowId).values[columnId],
        search = $("[data-choice-search]", d).value.trim();
      const selected = multi ? value : [value],
        matches = c.options.filter((o) =>
          o.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
        );
      $("[data-choice-list]", d).innerHTML =
        matches
          .map(
            (o) =>
              `<button type="button" data-choice="select" data-option="${o.id}" aria-pressed="${selected.includes(o.id)}" aria-label="${esc(o.label)}"><span class="sdb-tag sdb-tag-${o.color}">${esc(o.label)}</span><span aria-hidden="true">${selected.includes(o.id) ? "✓" : ""}</span></button>`,
          )
          .join("") +
        (!matches.length ? '<p class="sdb-hint">没有匹配选项</p>' : "") +
        (search &&
        !c.options.some((o) => o.label === search) &&
        c.options.length < 100
          ? '<button type="button" data-choice="create">＋ 创建「' +
            esc(search) +
            "」</button>"
          : "");
    };
    render();
    d.addEventListener("input", (e) => {
      if (e.target.matches("[data-choice-search]")) render();
    });
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-choice]");
      if (!b) return;
      try {
        const action = b.dataset.choice;
        if (action === "done") {
          d.close();
          return;
        }
        if (["clear", "select", "create"].includes(action)) {
          this.freezeView(id);
          this.mutate(id, (data) => {
            const c = data.columns.find((c) => c.id === columnId),
              r = data.rows.find((r) => r.id === rowId);
            if (action === "clear") {
              r.values[columnId] = emptyValue(c.type);
              return;
            }
            let optionId = b.dataset.option;
            if (action === "create") {
              const label = $("[data-choice-search]", d).value.trim();
              if (c.options.length >= 100)
                throw new Error("每个属性最多 100 个选项");
              const existing = c.options.find((o) => o.label === label);
              optionId = existing?.id || newId();
              if (!existing)
                c.options.push({ id: optionId, label, color: "gray" });
              $("[data-choice-search]", d).value = "";
            }
            if (multi) {
              const values = r.values[columnId];
              r.values[columnId] = values.includes(optionId)
                ? values.filter((v) => v !== optionId)
                : [...values, optionId];
            } else r.values[columnId] = optionId;
          });
          if (!multi) d.close();
          else render();
        }
      } catch (error) {
        this.error(d, error);
      }
    });
  }
  viewDialog(id, kind, anchor) {
    const data = this.data(id),
      old = data.view[kind];
    const d = this.dialog(
      "sdb-view-dialog",
      `<form><h3>${kind === "filter" ? "筛选记录" : "排序记录"}</h3><label>属性<select name="column"><option value="">不${kind === "filter" ? "筛选" : "排序"}</option>${options(
        data.columns.map((c) => [c.id, c.name]),
        old?.column || "",
      )}</select></label><div data-view-fields></div><p class="sdb-dialog-error" data-dialog-error role="alert"></p><footer><button type="button" data-view-cancel>取消</button><button type="submit" class="sdb-primary">应用</button></footer></form>`,
      anchor,
    );
    const fields = $("[data-view-fields]", d);
    const renderFields = (operator = old?.operator, value = old?.value) => {
      const colId = $('[name="column"]', d).value,
        c = data.columns.find((c) => c.id === colId);
      if (!c) {
        fields.innerHTML = "";
        return;
      }
      if (kind === "sort") {
        fields.innerHTML = `<label>顺序<select name="direction">${options(
          [
            ["asc", "升序"],
            ["desc", "降序"],
          ],
          old?.direction || "asc",
        )}</select></label>`;
        return;
      }
      const ops = operators(c.type);
      if (!ops.some(([op]) => op === operator)) operator = ops[0][0];
      let control = "";
      if (!["empty", "not-empty"].includes(operator)) {
        if (["select", "multi-select"].includes(c.type))
          control = `<select name="value" required><option value="">请选择</option>${options(
            c.options.map((o) => [o.id, o.label]),
            value,
          )}</select>`;
        else if (c.type === "checkbox")
          control = `<select name="value">${options(
            [
              ["true", "已勾选"],
              ["false", "未勾选"],
            ],
            String(value ?? true),
          )}</select>`;
        else
          control = `<input name="value" type="${c.type === "number" ? "number" : c.type === "date" ? "date" : "text"}" ${c.type === "number" ? 'step="any"' : c.type === "date" ? 'min="0001-01-01" max="9999-12-31"' : ""} maxlength="20000" value="${esc(value ?? "")}" ${c.type === "text" ? "" : "required"}>`;
      }
      fields.innerHTML = `<label>条件<select name="operator">${options(ops, operator)}</select></label>${control ? "<label>值" + control + "</label>" : ""}`;
    };
    renderFields();
    d.addEventListener("change", (e) => {
      if (e.target.name === "column") renderFields(null, null);
      if (e.target.name === "operator")
        renderFields(e.target.value, $('[name="value"]', d)?.value);
    });
    $("[data-view-cancel]", d).addEventListener("click", () => d.close());
    $("form", d).addEventListener("submit", (e) => {
      e.preventDefault();
      try {
        const column = $('[name="column"]', d).value,
          c = data.columns.find((c) => c.id === column);
        let value = null;
        if (c) {
          if (kind === "sort")
            value = { column, direction: $('[name="direction"]', d).value };
          else {
            const operator = $('[name="operator"]', d).value,
              raw = $('[name="value"]', d)?.value;
            value = {
              column,
              operator,
              value: ["empty", "not-empty"].includes(operator)
                ? null
                : c.type === "number"
                  ? Number(raw)
                  : c.type === "checkbox"
                    ? raw === "true"
                    : raw,
            };
          }
        }
        this.state(id).page = 0;
        this.state(id).frozenRows = null;
        this.mutate(id, (data) => (data.view[kind] = value));
        d.close();
      } catch (error) {
        this.error(d, error);
      }
    });
  }
}
