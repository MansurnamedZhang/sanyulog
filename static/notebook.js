import {
  newId,
  Autosave,
  escapeHTML as esc,
  renderMarkdown,
  formatSelection,
  createTable,
  tsvToTable,
  parseCSV,
  serializeCSV,
} from "./notebook-core.mjs";
const $ = (s, r) => r.querySelector(s),
  $$ = (s, r) => [...r.querySelectorAll(s)];
const labels = {
  markdown: "Markdown",
  code: "代码",
  log: "日志 / 原文",
  file: "图片 / 附件",
  table: "表格数据",
};
const makeCell = (type = "markdown") => ({
  id: newId(),
  type,
  source: type === "table" ? "列 1,列 2,列 3\r\n,,\r\n,," : "",
  language: type === "code" ? "python" : "",
  attachment_ids: [],
});
const metadata = [
  "title",
  "status",
  "tags",
  "goal",
  "params",
  "result",
  "conclusion",
  "next_step",
  "related_id",
];

export class Notebook {
  constructor({
    root,
    record,
    records,
    save,
    upload,
    readDraft,
    writeDraft,
    onSaved,
    toast,
  }) {
    this.root = root;
    this.record = record;
    this.records = records;
    this.upload = upload;
    this.toast = toast;
    this.writeDraft = writeDraft;
    this.tablePages = new Map();
    this.controller = new AbortController();
    this.active = "";
    this.editing = new Set();
    this.deleted = null;
    this.uploading = false;
    const savedDraft = readDraft(record.id),
      initial = {
        version: record.version,
        cells: record.cells,
        ...Object.fromEntries(metadata.map((k) => [k, record[k]])),
      };
    if (savedDraft) Object.assign(initial, savedDraft);
    this.queue = new Autosave({
      initial,
      save: async (data) => {
        if (data._paramError) throw new Error(data._paramError);
        const result = await save(record.id, data);
        const attachments = [
          ...new Map(
            [...this.record.attachments, ...result.attachments].map((a) => [
              a.id,
              a,
            ]),
          ).values(),
        ];
        this.record = { ...result, attachments };
        onSaved(this.record);
        return result;
      },
      persist: (data) => writeDraft(record.id, data),
      onStatus: (status, error) => this.status(status, error),
    });
    const signal = this.controller.signal;
    root.addEventListener(
      "click",
      (e) => this.handleClick(e).catch((err) => toast(err.message, true)),
      { signal },
    );
    root.addEventListener(
      "mousedown",
      (e) => {
        if (e.target.closest("[data-format]")) e.preventDefault();
      },
      { signal },
    );
    root.addEventListener("input", (e) => this.input(e), { signal });
    root.addEventListener("change", (e) => this.change(e), { signal });
    root.addEventListener("keydown", (e) => this.keydown(e), { signal });
    root.addEventListener("paste", (e) => this.paste(e), { signal });
    root.addEventListener(
      "focusin",
      (e) => {
        const cell = e.target.closest("[data-cell]");
        if (cell) this.setActive(cell.dataset.cell);
      },
      { signal },
    );
    root.ownerDocument.addEventListener(
      "click",
      (e) => this.previewOutside(e.target),
      { signal },
    );
    root.ownerDocument.addEventListener(
      "focusin",
      (e) => this.previewOutside(e.target),
      { signal },
    );
    this.render();
    if (savedDraft) {
      this.queue.change({});
      toast("已恢复未保存的 Notebook 草稿");
    }
    if (!this.queue.data.cells.length) this.insert("markdown", 0, false);
  }
  get dirty() {
    return this.queue.dirty;
  }
  async flush() {
    if (this.uploading) throw new Error("附件正在保存，请稍候");
    await this.queue.flush();
  }
  dispose() {
    this.queue.dispose();
    this.controller.abort();
  }
  status(status, error) {
    const el = $("[data-save-status]", this.root);
    if (!el) return;
    el.textContent = {
      pending: "待保存…",
      saving: "正在保存…",
      saved: "所有修改已保存",
      error: "保存失败 · 草稿已保留",
    }[status];
    el.dataset.state = status;
    const banner = $("[data-save-error]", this.root);
    banner.hidden = status !== "error";
    if (error)
      $("[data-error-message]", banner).textContent =
        error.status === 409
          ? "其他窗口已修改此笔记本。请先下载草稿，再重新载入已保存内容。"
          : error.message;
  }
  render() {
    const d = this.queue.data;
    this.root.classList.add("notebook-detail");
    this.root.innerHTML = `<div class="nb-header"><div class="nb-caption">NOTEBOOK <span> / ${this.record.id.slice(0, 6).toUpperCase()}</span></div><div class="detail-actions"><button class="button small" data-action="duplicate">复制</button><button class="button small" data-action="compare">对比</button><button class="button small" data-action="export">导出</button><button class="button small danger" data-action="delete-record">删除</button></div></div>
      <input class="nb-title" data-meta="title" maxlength="300" aria-label="笔记本标题" value="${esc(d.title)}" placeholder="未命名笔记本">
      <div class="nb-subtitle"><span data-save-status data-state="saved">已保存到本地</span><span data-cell-count>${d.cells.length} 个单元格</span></div>
      <div class="nb-error" data-save-error hidden><span data-error-message></span><div><button class="button small" data-nb="save">重试保存</button><button class="button small" data-nb="download-draft">下载草稿</button><button class="button small" data-nb="reload">载入已保存内容</button></div></div>
      <details class="nb-properties"><summary>属性与实验配置 <span>状态、标签、参数、复盘</span></summary><div class="nb-property-body"><div class="record-fields"><label class="field">状态<select data-meta="status">${["进行中", "已完成", "受阻", "已搁置"].map((s) => `<option ${d.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label><label class="field">标签<input data-meta="tags" value="${esc(d.tags.join("，"))}" placeholder="用逗号分隔"></label></div><label class="field">目标<textarea data-meta="goal">${esc(d.goal)}</textarea></label><div class="section-heading"><h3>参数与配置</h3><button class="text-button" data-nb="add-param">＋ 添加参数</button></div><div class="param-table" data-params>${this.paramRows(d.params)}</div><div class="nb-review">${[
        ["result", "结果"],
        ["conclusion", "结论"],
        ["next_step", "下一步"],
      ]
        .map(
          ([key, label]) =>
            `<label class="field">${label}<textarea data-meta="${key}">${esc(d[key])}</textarea></label>`,
        )
        .join(
          "",
        )}<label class="field">关联记录<select data-meta="related_id"><option value="">不关联</option>${this.records
        .filter((r) => r.id !== this.record.id)
        .map(
          (r) =>
            `<option value="${r.id}" ${r.id === d.related_id ? "selected" : ""}>${esc(r.title)}</option>`,
        )
        .join("")}</select></label></div></div></details>
      <div class="nb-toolbar"><div><button class="button small" data-nb="add" data-type="markdown">＋ 文本</button><button class="button small" data-nb="add" data-type="code">＋ 代码</button><button class="button small" data-nb="add" data-type="log">＋ 日志</button><button class="button small" data-nb="add" data-type="file">＋ 附件</button><button class="button small" data-nb="add" data-type="table">＋ 表格</button></div><button class="text-button" data-nb="help">快捷键 / 语法</button></div>
      <div class="nb-help" data-help hidden><b>像笔记本一样，持续记录</b><p>Shift+Enter：保存并进入下一格 · Ctrl+S：立即保存 · 代码格内 Tab：缩进。空闲 0.8 秒后自动保存。</p><p>Markdown：# 标题、**加粗**、- 列表、[链接](https://...)、表格和三反引号代码块。代码格用于记录；运行结果可放在下一格日志中。支持粘贴图片或上传任意文件。</p></div>
      <div class="nb-cells" data-cells></div><div class="nb-end"><span>继续记下一个想法</span><div><button class="button" data-nb="append" data-type="markdown">＋ 文本单元</button><button class="button subtle" data-nb="append" data-type="code">＋ 代码</button><button class="button subtle" data-nb="append" data-type="file">＋ 图片 / 附件</button><button class="button subtle" data-nb="append" data-type="table">＋ 表格</button></div></div>
      <div class="nb-bottom"><span data-upload-status></span><button class="text-button" data-nb="undo" hidden>↶ 撤销删除单元格</button></div><details class="nb-library"><summary>本笔记本的全部附件 <span>${this.record.attachments.length}</span></summary><div data-library></div></details><input type="file" data-file-input multiple hidden>`;
    if (d._paramRows)
      $("[data-params]", this.root).innerHTML = d._paramRows
        .map(([key, value]) => this.paramRows({ [key]: value }))
        .join("");
    this.renderCells();
    this.renderLibrary();
  }
  paramRows(params) {
    return Object.entries(params)
      .map(
        ([key, value]) =>
          `<div class="param-row"><input data-param-key aria-label="参数名称" placeholder="参数名称" value="${esc(key)}"><input data-param-value aria-label="参数值" placeholder="参数值" value="${esc(value)}"><button class="icon-button" data-nb="remove-param" aria-label="删除参数">×</button></div>`,
      )
      .join("");
  }
  renderCells(focusId) {
    $("[data-cells]", this.root).innerHTML = this.queue.data.cells
      .map((cell, index) => this.cellHTML(cell, index))
      .join("");
    $("[data-cell-count]", this.root).textContent =
      this.queue.data.cells.length + " 个单元格";
    for (const area of $$("[data-source]", this.root)) this.grow(area);
    if (focusId) {
      this.setActive(focusId);
      const el = this.cellElement(focusId);
      ($("[data-source]", el) || el)?.focus();
    }
  }
  cellElement(id) {
    return $(`[data-cell="${id}"]`, this.root);
  }
  formatToolbar() {
    return (
      '<div class="nb-format-toolbar" role="toolbar" aria-label="Markdown 格式工具">' +
      [
        ["bold", "B", "加粗"],
        ["italic", "I", "斜体"],
        ["heading", "H₂", "二级标题"],
        ["unordered", "• 列表", "无序列表"],
        ["ordered", "1. 列表", "有序列表"],
        ["indent", "→ 缩进", "增加缩进 / 子列表"],
        ["outdent", "← 缩进", "减少缩进"],
        ["code", "&lt;/&gt;", "行内代码"],
        ["codeblock", "代码块", "代码块"],
        ["table", "▦ 表格", "插入表格"],
        ["math", "x²", "行内公式"],
        ["mathblock", "∑ 公式", "独立公式"],
      ]
        .map(
          ([tool, label, title]) =>
            `<button type="button" class="text-button" data-nb="format" data-format="${tool}" title="${title}" aria-label="${title}">${label}</button>`,
        )
        .join("") +
      "</div>"
    );
  }
  previewOutside(target) {
    const inside = this.root.contains(target)
      ? target.closest("[data-cell]")?.dataset.cell
      : null;
    for (const id of this.editing) {
      const cell = this.cell(id);
      if (id === inside || cell?.type !== "markdown" || !cell.source.trim())
        continue;
      const element = this.cellElement(id),
        source = element?.querySelector("[data-source]");
      if (!source) continue;
      const preview = this.root.ownerDocument.createElement("div");
      element.querySelector(".nb-table-picker")?.remove();
      preview.className = "nb-markdown";
      preview.dataset.nb = "edit-preview";
      preview.innerHTML = renderMarkdown(cell.source);
      source.replaceWith(preview);
      element.classList.add("preview");
      const toggle = element.querySelector('[data-nb="toggle"]');
      if (toggle) toggle.textContent = "编辑";
      this.editing.delete(id);
    }
  }
  cellHTML(cell, index) {
    const editing =
      this.editing.has(cell.id) || !cell.source || cell.type !== "markdown";
    const preview = cell.type === "markdown" && !editing;
    return `<div class="nb-insert"><button data-nb="insert" data-index="${index}" title="在此插入单元格">＋</button></div><article class="nb-cell ${this.active === cell.id ? "active" : ""} ${preview ? "preview" : ""}" data-cell="${cell.id}" tabindex="0"><div class="nb-gutter">[${String(index + 1).padStart(2, "0")}]</div><div class="nb-cell-main"><div class="nb-cell-bar"><div><select data-cell-type aria-label="单元格类型">${Object.entries(
      labels,
    )
      .map(
        ([type, label]) =>
          `<option value="${type}" ${cell.type === type ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select>${cell.type === "code" ? `<input class="nb-language" data-language aria-label="代码语言" maxlength="40" placeholder="语言" value="${esc(cell.language)}" list="nb-languages">` : ""}</div><div class="nb-cell-actions">${cell.type === "markdown" ? `<button data-nb="toggle" class="text-button">${preview ? "编辑" : "预览"}</button>` : ""}<button data-nb="cell-file" class="text-button" title="向此单元格添加图片或附件">附件</button><button data-nb="up" class="text-button" title="上移单元格" ${index === 0 ? "disabled" : ""}>↑</button><button data-nb="down" class="text-button" title="下移单元格" ${index === this.queue.data.cells.length - 1 ? "disabled" : ""}>↓</button><button data-nb="cell-delete" class="text-button" title="删除单元格">×</button></div></div>${cell.type === "markdown" ? this.formatToolbar() : ""}${cell.type === "table" ? this.tableHTML(cell) : preview ? `<div class="nb-markdown" data-nb="edit-preview">${renderMarkdown(cell.source)}</div>` : `<textarea data-source class="nb-source ${cell.type === "code" ? "code" : cell.type === "log" ? "log" : ""}" spellcheck="${cell.type === "markdown"}" aria-label="${labels[cell.type]}单元格内容" placeholder="${cell.type === "markdown" ? "写下想法、步骤、结论… 支持 Markdown" : cell.type === "code" ? "粘贴命令、配置或代码…" : cell.type === "log" ? "粘贴输出、报错或原始日志…" : "添加说明，或点击下方上传文件"}">${esc(cell.source)}</textarea>`}
      <div class="nb-cell-files">${this.filesHTML(cell.attachment_ids)}</div>${cell.type === "file" ? '<button class="nb-upload" data-nb="cell-file">＋ 上传图片或文件 <span>也可以直接粘贴截图 · 单个最大 25 MB</span></button>' : ""}</div></article>`;
  }
  tableRows(cell) {
    const rows = parseCSV(cell.source),
      width = Math.max(...rows.map((r) => r.length));
    return rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  }
  tableHTML(cell) {
    const rows = this.tableRows(cell),
      pages = Math.max(1, Math.ceil((rows.length - 1) / 50)),
      page = Math.min(this.tablePages.get(cell.id) || 0, pages - 1);
    this.tablePages.set(cell.id, page);
    const rowHTML = (row, r) =>
      `<tr><th>${r === 0 ? "表头" : r}</th>${row.map((v, c) => `<td><textarea data-grid-row="${r}" data-grid-col="${c}" aria-label="第 ${r} 行第 ${c + 1} 列">${esc(v)}</textarea>${r === 0 ? `<button class="text-button" data-nb="grid-delete-column" data-column="${c}" title="删除此列">×</button>` : ""}</td>`).join("")}${r ? `<td><button class="text-button" data-nb="grid-delete-row" data-row="${r}" title="删除此行">×</button></td>` : "<td></td>"}</tr>`;
    return `<div class="nb-grid-tools"><button class="button small" data-nb="grid-add-row">＋ 行</button><button class="button small" data-nb="grid-add-column">＋ 列</button><button class="button small" data-nb="grid-import">导入 CSV / TSV</button><select data-csv-encoding aria-label="CSV 编码"><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option></select><input type="file" data-csv-input accept=".csv,.tsv,text/csv" hidden><button class="button small" data-nb="grid-export">导出 CSV</button><span>${rows.length - 1} 行 × ${rows[0].length} 列</span></div><div class="nb-data-grid"><table><thead>${rowHTML(rows[0], 0)}</thead><tbody>${rows
      .slice(1 + page * 50, 1 + (page + 1) * 50)
      .map((r, i) => rowHTML(r, 1 + page * 50 + i))
      .join(
        "",
      )}</tbody></table></div><div class="nb-grid-tools"><button class="text-button" data-nb="grid-prev" ${page === 0 ? "disabled" : ""}>上一页</button><span>${page + 1} / ${pages}</span><button class="text-button" data-nb="grid-next" ${page === pages - 1 ? "disabled" : ""}>下一页</button><small>第一行为表头；支持粘贴 CSV 或 Excel 区域，最多 1000 行数据、50 列。</small></div>`;
  }
  saveTable(cell, rows) {
    const source = serializeCSV(rows);
    parseCSV(source);
    cell.source = source;
    this.queue.change({ cells: this.queue.data.cells });
  }
  async importCSV(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = "";
    const element = input.closest("[data-cell]"),
      cell = this.cell(element.dataset.cell),
      original = cell.source,
      encoding = $("[data-csv-encoding]", element).value;
    if (file.size > 1500000) throw new Error("CSV 文件过大，最多 1.5 MB");
    if (!confirm("导入文件将替换这个表格的全部内容，继续？")) return;
    const text = new TextDecoder(encoding, { fatal: true }).decode(
        await file.arrayBuffer(),
      ),
      rows = parseCSV(
        text,
        file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
      );
    if (
      this.controller.signal.aborted ||
      this.cell(cell.id) !== cell ||
      cell.source !== original ||
      cell.type !== "table"
    )
      throw new Error("表格已发生变化，请重新导入");
    this.saveTable(cell, rows);
    this.tablePages.set(cell.id, 0);
    this.renderCells();
    this.toast("已导入表格，第一行为表头");
  }
  filesHTML(ids) {
    return ids
      .map((id) => {
        const a = this.record.attachments.find((a) => a.id === id);
        if (!a) return "";
        const image = [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
        ].includes(a.mime);
        return `<div class="nb-file">${image ? `<a href="/api/attachments/${id}?preview=1" target="_blank" rel="noopener"><img src="/api/attachments/${id}?preview=1" alt="${esc(a.name)}" loading="lazy"></a>` : ""}<div><a href="/api/attachments/${id}">▧ ${esc(a.name)}</a><small>${(a.size / 1024).toFixed(1)} KB</small><button class="text-button" data-nb="unlink-file" data-file="${id}">移出此格</button></div></div>`;
      })
      .join("");
  }
  renderLibrary() {
    const library = $("[data-library]", this.root);
    library.innerHTML = this.record.attachments.length
      ? this.record.attachments
          .map(
            (a) =>
              `<div class="nb-library-item"><a href="/api/attachments/${a.id}">${esc(a.name)}</a><button class="text-button" data-nb="reuse-file" data-file="${a.id}">插入正文</button></div>`,
          )
          .join("")
      : '<p class="hint">上传过的附件会列在这里。移出单元格后仍可重新插入。</p>';
    $(".nb-library summary span", this.root).textContent =
      this.record.attachments.length;
  }
  setActive(id) {
    this.active = id;
    $$("[data-cell]", this.root).forEach((el) =>
      el.classList.toggle("active", el.dataset.cell === id),
    );
  }
  grow(area) {
    area.style.height = "auto";
    area.style.height = Math.max(64, area.scrollHeight) + "px";
  }
  cell(id = this.active) {
    return this.queue.data.cells.find((c) => c.id === id);
  }
  changeCells(cells) {
    this.queue.change({ cells });
  }
  insert(type, index, focus = true) {
    const cell = makeCell(type),
      cells = structuredClone(this.queue.data.cells);
    cells.splice(index, 0, cell);
    this.editing.add(cell.id);
    this.active = cell.id;
    this.changeCells(cells);
    this.renderCells(focus ? cell.id : undefined);
    return cell.id;
  }
  input(event) {
    const target = event.target;
    event.stopPropagation();
    if (target.matches("[data-grid-row]")) {
      const cell = this.cell(target.closest("[data-cell]").dataset.cell),
        rows = this.tableRows(cell);
      rows[Number(target.dataset.gridRow)][Number(target.dataset.gridCol)] =
        target.value;
      this.saveTable(cell, rows);
    } else if (target.matches("[data-source]")) {
      const cell = this.cell(target.closest("[data-cell]").dataset.cell);
      cell.source = target.value;
      this.grow(target);
      this.queue.change({ cells: this.queue.data.cells });
    } else if (target.matches("[data-language]")) {
      const cell = this.cell(target.closest("[data-cell]").dataset.cell);
      cell.language = target.value;
      this.queue.change({ cells: this.queue.data.cells });
    } else if (target.matches("[data-meta]")) {
      let value = target.value;
      if (target.dataset.meta === "tags")
        value = value
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);
      if (target.dataset.meta === "related_id") value = value || null;
      this.queue.change({ [target.dataset.meta]: value });
    } else if (target.matches("[data-param-key],[data-param-value]"))
      this.saveParams();
  }
  saveParams() {
    const params = {},
      rows = $$(".param-row", this.root).map((row) => [
        $("[data-param-key]", row).value,
        $("[data-param-value]", row).value,
      ]);
    let error = "";
    for (const [raw, value] of rows) {
      const key = raw.trim();
      if (!key && value) {
        error = "请为参数填写名称后再保存";
        break;
      }
      if (!key) continue;
      if (Object.hasOwn(params, key)) {
        error = "参数名称不能重复";
        break;
      }
      Object.defineProperty(params, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    this.queue.change({
      _paramRows: rows,
      _paramError: error,
      ...(!error ? { params } : {}),
    });
  }
  change(event) {
    if (event.target.matches("[data-csv-input]")) {
      this.importCSV(event.target).catch((e) => this.toast(e.message, true));
      return;
    }
    if (event.target.matches("[data-cell-type]")) {
      event.stopPropagation();
      const id = event.target.closest("[data-cell]").dataset.cell,
        cell = this.cell(id);
      if (event.target.value === "table") {
        try {
          parseCSV(cell.source);
        } catch (e) {
          event.target.value = cell.type;
          this.toast(e.message, true);
          return;
        }
      }
      cell.type = event.target.value;
      this.editing.add(id);
      this.queue.change({ cells: this.queue.data.cells });
      this.renderCells(id);
    }
    if (event.target.matches("[data-file-input]")) {
      const files = [...event.target.files];
      event.target.value = "";
      this.uploadFiles(files, this.fileTarget).catch((e) =>
        this.toast(e.message, true),
      );
    }
  }
  async handleClick(event) {
    this.previewOutside(event.target);
    const button = event.target.closest("[data-nb]");
    if (!button) return;
    event.stopPropagation();
    if (event.target.closest("a")) return;
    const action = button.dataset.nb,
      id = button.closest("[data-cell]")?.dataset.cell;
    if (id) this.setActive(id);
    if (action.startsWith("grid-")) {
      const cell = this.cell(id),
        rows = this.tableRows(cell),
        page = this.tablePages.get(id) || 0;
      if (action === "grid-import") {
        $("[data-csv-input]", this.cellElement(id)).click();
        return;
      }
      if (action === "grid-export") {
        const url = URL.createObjectURL(
            new Blob(["\uFEFF" + serializeCSV(rows)], {
              type: "text/csv;charset=utf-8",
            }),
          ),
          a = document.createElement("a");
        a.href = url;
        a.download = this.queue.data.title + "-表格.csv";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return;
      }
      if (action === "grid-prev" || action === "grid-next")
        this.tablePages.set(id, page + (action === "grid-next" ? 1 : -1));
      else {
        if (action === "grid-add-row") {
          if (rows.length >= 1001) throw new Error("最多 1000 行数据");
          rows.push(Array(rows[0].length).fill(""));
          this.tablePages.set(id, Math.floor((rows.length - 2) / 50));
        }
        if (action === "grid-add-column") {
          if (rows[0].length >= 50) throw new Error("最多 50 列");
          rows.forEach((r, i) => r.push(i === 0 ? "列 " + (r.length + 1) : ""));
        }
        if (action === "grid-delete-row") {
          if (!confirm("删除此行数据？")) return;
          rows.splice(Number(button.dataset.row), 1);
        }
        if (action === "grid-delete-column") {
          if (rows[0].length === 1) throw new Error("至少保留一列");
          if (!confirm("删除此列及其数据？")) return;
          rows.forEach((r) => r.splice(Number(button.dataset.column), 1));
        }
        this.saveTable(cell, rows);
      }
      this.renderCells();
      return;
    }
    if (action === "format") {
      let element = this.cellElement(id),
        area = $("[data-source]", element);
      if (!area) {
        this.editing.add(id);
        this.renderCells(id);
        element = this.cellElement(id);
        area = $("[data-source]", element);
        area.setSelectionRange(area.value.length, area.value.length);
      }
      if (button.dataset.format === "table") {
        if (!$(".nb-table-picker", element))
          $(".nb-format-toolbar", element).insertAdjacentHTML(
            "afterend",
            '<div class="nb-table-picker"><label>数据行数 <input type="number" data-table-rows min="1" max="100" value="3"></label><label>列数 <input type="number" data-table-columns min="1" max="20" value="3"></label><button class="button small" data-nb="insert-table">插入表格</button><button class="text-button" data-nb="cancel-table">取消</button><small>另含一行表头；也可直接粘贴 Excel 单元格。</small></div>',
          );
        return;
      }
      const result = formatSelection(
        area.value,
        area.selectionStart,
        area.selectionEnd,
        button.dataset.format,
      );
      area.value = result.text;
      area.focus();
      area.setSelectionRange(result.start, result.end);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (action === "cancel-table") {
      button.closest(".nb-table-picker").remove();
      return;
    }
    if (action === "insert-table") {
      const element = this.cellElement(id),
        picker = button.closest(".nb-table-picker"),
        area = $("[data-source]", element);
      const table = createTable(
        Number($("[data-table-rows]", picker).value),
        Number($("[data-table-columns]", picker).value),
      );
      area.setRangeText(table, area.selectionStart, area.selectionEnd, "end");
      picker.remove();
      area.focus();
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const cells = structuredClone(this.queue.data.cells),
      index = cells.findIndex((c) => c.id === id);
    if (["add", "append", "insert"].includes(action)) {
      const position =
        action === "append"
          ? cells.length
          : action === "insert"
            ? Number(button.dataset.index)
            : this.active
              ? cells.findIndex((c) => c.id === this.active) + 1
              : cells.length;
      this.insert(button.dataset.type || "markdown", position);
      return;
    }
    if (action === "toggle" || action === "edit-preview") {
      if (this.editing.has(id) && action !== "edit-preview") {
        await this.queue.flush();
        this.editing.delete(id);
      } else this.editing.add(id);
      this.renderCells(this.editing.has(id) ? id : undefined);
      return;
    }
    if (action === "up" || action === "down") {
      const next = index + (action === "up" ? -1 : 1);
      if (next < 0 || next >= cells.length) return;
      [cells[index], cells[next]] = [cells[next], cells[index]];
      this.changeCells(cells);
      this.renderCells(id);
      return;
    }
    if (action === "cell-delete") {
      if (!confirm("删除这个单元格？之后可点击底部撤销。")) return;
      this.deleted = { cell: cells[index], index };
      cells.splice(index, 1);
      this.changeCells(cells);
      this.renderCells();
      $("[data-nb=undo]", this.root).hidden = false;
      return;
    }
    if (action === "undo" && this.deleted) {
      cells.splice(
        Math.min(this.deleted.index, cells.length),
        0,
        this.deleted.cell,
      );
      this.changeCells(cells);
      this.renderCells(this.deleted.cell.id);
      this.deleted = null;
      button.hidden = true;
      return;
    }
    if (action === "cell-file") {
      this.fileTarget = id;
      $("[data-file-input]", this.root).click();
      return;
    }
    if (action === "unlink-file") {
      cells[index].attachment_ids = cells[index].attachment_ids.filter(
        (a) => a !== button.dataset.file,
      );
      this.changeCells(cells);
      this.renderCells();
      return;
    }
    if (action === "reuse-file") {
      const target = this.insert("file", cells.length);
      this.cell(target).attachment_ids.push(button.dataset.file);
      this.queue.change({ cells: this.queue.data.cells });
      this.renderCells();
      return;
    }
    if (action === "save") {
      await this.queue.flush();
      return;
    }
    if (action === "reload") {
      if (confirm("载入已保存内容并放弃当前草稿？建议先下载草稿。")) {
        this.queue.dispose();
        this.writeDraft(this.record.id, null);
        this.queue.savedRevision = this.queue.revision;
        location.reload();
      }
      return;
    }
    if (action === "download-draft") {
      const blob = new Blob([JSON.stringify(this.queue.data, null, 2)], {
          type: "application/json",
        }),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "notebook-draft.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }
    if (action === "help") {
      $("[data-help]", this.root).hidden = !$("[data-help]", this.root).hidden;
      return;
    }
    if (action === "add-param") {
      $("[data-params]", this.root).insertAdjacentHTML(
        "beforeend",
        this.paramRows({ "": "" }),
      );
      $("[data-params] .param-row:last-child input", this.root).focus();
      return;
    }
    if (action === "remove-param") {
      button.closest(".param-row").remove();
      this.saveParams();
    }
  }
  keydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      this.flush().catch((e) => this.toast(e.message, true));
      return;
    }
    const el = event.target.closest("[data-cell]");
    if (!el) return;
    if (event.shiftKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const id = el.dataset.cell;
      this.queue
        .flush()
        .then(() => {
          const index = this.queue.data.cells.findIndex((c) => c.id === id),
            next = this.queue.data.cells[index + 1];
          this.editing.delete(id);
          if (next) {
            this.editing.add(next.id);
            this.renderCells(next.id);
          } else this.insert("markdown", index + 1);
        })
        .catch((e) => this.toast(e.message, true));
    }
    if (
      event.key === "Tab" &&
      event.target.matches("[data-source]") &&
      this.cell(el.dataset.cell).type !== "markdown"
    ) {
      event.preventDefault();
      const area = event.target;
      area.setRangeText("    ", area.selectionStart, area.selectionEnd, "end");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  paste(event) {
    const area = event.target,
      cell = this.cell(area.closest("[data-cell]")?.dataset.cell);
    const text = event.clipboardData?.getData("text/plain") || "";
    if (area.matches("[data-grid-row]") && /[\t\r\n]/.test(text)) {
      event.preventDefault();
      event.stopPropagation();
      try {
        const incoming = parseCSV(text, text.includes("\t") ? "\t" : ","),
          rows = this.tableRows(cell),
          startRow = Number(area.dataset.gridRow),
          startCol = Number(area.dataset.gridCol),
          width = Math.max(
            rows[0].length,
            startCol + Math.max(...incoming.map((r) => r.length)),
          );
        if (startRow + incoming.length > 1001 || width > 50)
          throw new Error("最多 1000 行数据、50 列");
        while (rows.length < startRow + incoming.length) rows.push([]);
        rows.forEach((r) => {
          while (r.length < width) r.push("");
        });
        incoming.forEach((r, i) =>
          r.forEach((v, j) => (rows[startRow + i][startCol + j] = v)),
        );
        this.saveTable(cell, rows);
        this.renderCells();
      } catch (e) {
        this.toast(e.message, true);
      }
      return;
    }
    if (
      area.matches("[data-source]") &&
      cell?.type === "markdown" &&
      !event.shiftKey
    ) {
      const table = tsvToTable(text);
      if (table) {
        event.preventDefault();
        event.stopPropagation();
        area.setRangeText(table, area.selectionStart, area.selectionEnd, "end");
        area.dispatchEvent(new Event("input", { bubbles: true }));
        this.toast("已转为表格，第一行为表头");
        return;
      }
    }
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    let id = area.closest("[data-cell]")?.dataset.cell || this.active;
    if (!id || !this.cell(id))
      id = this.insert("file", this.queue.data.cells.length);
    this.uploadFiles(files, id).catch((e) => this.toast(e.message, true));
  }
  async uploadFiles(files, id) {
    if (!files.length) return;
    if (this.uploading) throw new Error("附件正在上传，请稍候");
    if (!this.cell(id)) throw new Error("单元格已删除，请重新选择");
    this.uploading = true;
    try {
      for (const file of files) {
        $("[data-upload-status]", this.root).textContent =
          "正在保存 " + file.name;
        const attachment = await this.upload(this.record.id, file);
        this.record.attachments.push(attachment);
        if (this.cell(id)) {
          this.cell(id).attachment_ids.push(attachment.id);
          this.queue.change({ cells: this.queue.data.cells });
        }
        this.renderLibrary();
        const el = this.cellElement(id);
        if (el)
          $(".nb-cell-files", el).innerHTML = this.filesHTML(
            this.cell(id).attachment_ids,
          );
      }
      await this.queue.flush();
      this.toast("附件已插入笔记本");
    } finally {
      this.uploading = false;
      $("[data-upload-status]", this.root).textContent = "";
    }
  }
}
