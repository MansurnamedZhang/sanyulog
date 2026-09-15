import { newId } from "./notebook-core.mjs";
import { Notebook } from "./notebook.js";
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (value, full = false) =>
  new Date(value).toLocaleString(
    "zh-CN",
    full
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { month: "2-digit", day: "2-digit" },
  );
const statusClass = (s) =>
  ({ 已完成: "done", 受阻: "blocked", 已搁置: "paused" })[s] || "";
let state = { projects: [], records: [], templates: [] };
let workspace = readLocal("process-log:workspace") || "default";
let project = "",
  selected = "",
  tab = "timeline",
  dirty = false,
  busy = false,
  toastTimer;
let templateWork = [],
  templateIndex = 0;
let notebook = null;
const current = () => state.records.find((r) => r.id === selected);
const draftKey = (id) => "process-log:draft:" + id;
const entryKey = (id) => "process-log:entry:" + id;
function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function writeLocal(key, value) {
  try {
    value === null
      ? localStorage.removeItem(key)
      : localStorage.setItem(key, JSON.stringify(value));
  } catch {
    toast("浏览器草稿空间不可用，请及时点击保存。", true);
  }
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").className = error ? "error" : "";
  $("#toast").hidden = false;
  toastTimer = setTimeout(
    () => ($("#toast").hidden = true),
    error ? 11000 : 4200,
  );
}
async function api(path, method = "GET", data) {
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Process-Log": "1" },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  } catch {
    throw new Error(
      "无法连接本地服务，请重新启动工具。输入已保留，请勿清除浏览器数据。",
    );
  }
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || "操作失败，请重试"), {
      status: response.status,
    });
  return result;
}
async function refresh(detail = true) {
  state = await api("/state");
  if (!state.workspaces.some((w) => w.id === workspace)) workspace = "default";
  state.projects = state.projects.filter((p) => p.workspace_id === workspace);
  const projectIds = new Set(state.projects.map((p) => p.id));
  state.records = state.records.filter((r) => projectIds.has(r.project_id));
  if (project && !state.projects.some((p) => p.id === project)) project = "";
  if (selected && !current()) selected = "";
  renderNav();
  renderList();
  if (detail) renderDetail();
}
function renderNav() {
  $("[data-action=navigation]").setAttribute(
    "aria-expanded",
    String(document.body.classList.contains("navigation-open")),
  );
  $("#workspace-select").innerHTML = state.workspaces
    .map(
      (w) =>
        `<option value="${esc(w.id)}" ${w.id === workspace ? "selected" : ""}>${esc(w.name)}</option>`,
    )
    .join("");
  $("#workspace-label").textContent =
    state.workspaces.find((w) => w.id === workspace)?.name || "默认工作空间";
  const p = state.projects.find((p) => p.id === project);
  $("#project-label").textContent = $("#page-title").textContent =
    p?.name || "全部记录";
  $("#project-settings").hidden = !p;
  const count = state.records.filter(
    (r) => !project || r.project_id === project,
  ).length;
  const active = state.records.filter(
    (r) => (!project || r.project_id === project) && r.status === "进行中",
  ).length;
  $("#page-description").textContent = count
    ? `${count} 本笔记 · ${active} 条进行中`
    : "用文字、代码和图片，接着记录每一次探索。";
  $("#projects").innerHTML =
    `<button class="project-nav ${!project ? "active" : ""}" data-action="project" data-id=""><span class="project-symbol">▦</span><span class="nav-title">全部记录</span><small>${state.records.length}</small></button>` +
    state.projects
      .map(
        (p) =>
          `<button class="project-nav ${p.id === project ? "active" : ""}" data-action="project" data-id="${p.id}"><span class="project-symbol">▱</span><span class="nav-title">${esc(p.name)}</span><small>${state.records.filter((r) => r.project_id === p.id).length}</small></button>`,
      )
      .join("");
  const value = $("#tag-filter").value;
  const tags = [
    ...new Set(
      state.records
        .filter((r) => !project || r.project_id === project)
        .flatMap((r) => r.tags),
    ),
  ].sort();
  $("#tag-filter").innerHTML =
    '<option value="">全部标签</option>' +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  if (tags.includes(value)) $("#tag-filter").value = value;
}
function filtered() {
  const q = $("#search").value.trim().toLocaleLowerCase(),
    status = $("#status-filter").value,
    tagFilter = $("#tag-filter").value;
  return state.records.filter(
    (r) =>
      (!project || r.project_id === project) &&
      (!status || r.status === status) &&
      (!tagFilter || r.tags.includes(tagFilter)) &&
      (!q ||
        JSON.stringify([
          r.title,
          r.goal,
          r.params,
          r.tags,
          r.result,
          r.conclusion,
          r.next_step,
          r.cells,
          r.attachments.map((a) => a.name),
        ])
          .toLocaleLowerCase()
          .includes(q)),
  );
}
function renderList() {
  const records = filtered();
  $("#record-count").textContent = records.length + " 条";
  $("#records").innerHTML = records.length
    ? records
        .map(
          (r) =>
            `<button class="record-card ${r.id === selected ? "active" : ""}" data-action="select" data-id="${r.id}" aria-pressed="${r.id === selected}"><div class="card-top"><span class="status ${statusClass(r.status)}">${esc(r.status)}</span><time>${fmt(r.updated)}</time></div><h3>${esc(r.title)}</h3><p class="card-excerpt">${esc(
              (
                r.cells?.find((c) => c.source.trim())?.source ||
                r.goal ||
                "空白笔记本，从一个单元格开始。"
              )
                .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/gm, "")
                .replace(/[*`]/g, "")
                .replace(/\s+/g, " "),
            )}</p><div class="card-bottom"><span>${r.tags.length ? "# " + esc(r.tags.slice(0, 2).join(" · ")) : esc(state.projects.find((p) => p.id === r.project_id)?.name || "")}</span><span>${r.cells?.length || 0} 个单元</span></div></button>`,
        )
        .join("")
    : `<div class="padded"><p class="muted">${state.records.length ? "没有匹配的记录。试试其他关键词或筛选条件。" : "记录会按最近更新时间排列在这里。"}</p></div>`;
}
function selectRecord(id) {
  document.body.classList.add("reading-note");
  document.body.classList.remove("navigation-open");
  document.body.classList.add("has-note");
  selected = id;
  dirty = false;
  tab = "timeline";
  renderList();
  renderDetail();
  $("#detail").scrollTop = 0;
}
function renderDetail() {
  notebook?.dispose();
  notebook = null;
  const r = current();
  $("#detail").classList.remove("notebook-detail");
  if (!r) {
    document.body.classList.remove("reading-note", "has-note", "focus-mode");
    const focusButton = $("[data-action=focus-mode]");
    focusButton.textContent = "专注模式";
    focusButton.setAttribute("aria-pressed", "false");
    $("#detail").innerHTML =
      `<div class="empty"><div class="empty-glyph">[ ]</div><span class="eyebrow">一本持续生长的过程笔记</span><h2>${state.records.length ? "选择笔记本，接着往下写" : "从一个想法，开始记录"}</h2><p>文字、代码、日志和图片，按你的思路排列。<br>随时追加一个单元格，继续上一次的探索。</p><button class="button primary" data-action="new-record">＋ 新建笔记本</button></div>`;
    return;
  }
  notebook = new Notebook({
    root: $("#detail"),
    record: r,
    records: state.records,
    readDraft: (id) => {
      const draft = readLocal("process-log:notebook:" + id);
      if (draft) return draft;
      const legacy = readLocal(draftKey(id)),
        entry = readLocal(entryKey(id));
      if (!legacy && !entry?.body) return null;
      const cells = structuredClone(r.cells);
      if (entry?.body)
        cells.push({
          id: newId(),
          type: "markdown",
          source: entry.body,
          language: "",
          attachment_ids: [],
        });
      return { ...(legacy || {}), cells };
    },
    writeDraft: (id, data) => {
      writeLocal("process-log:notebook:" + id, data);
      if (data === null) {
        writeLocal(draftKey(id), null);
        writeLocal(entryKey(id), null);
      }
    },
    save: (id, data) => api("/records/" + id, "PUT", data),
    upload: async (id, file) => {
      if (file.size > 25 * 1024 * 1024)
        throw new Error("单个附件不能超过 25 MB");
      const response = await fetch("/api/records/" + id + "/attachments", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
          "X-Process-Log": "1",
        },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "附件上传失败");
      return result;
    },
    onSaved: (r) => {
      state.records = state.records
        .map((old) => (old.id === r.id ? r : old))
        .sort((a, b) => b.updated.localeCompare(a.updated));
      renderNav();
      renderList();
    },
    toast,
  });
}
function modal(title, content, wide = false) {
  $("#modal-title").textContent = title;
  $("#modal-content").innerHTML = content;
  $("#modal").classList.toggle("modal-wide", wide);
  if (!$("#modal").open) $("#modal").showModal();
  setTimeout(
    () => $("#modal-content input, #modal-content textarea")?.focus(),
    0,
  );
}
const footer = (label) =>
  `<p class="modal-error" role="alert" hidden></p><div class="modal-footer"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary" type="submit">${label}</button></div>`;
function newProject() {
  modal(
    "新建项目",
    `<form id="project-form"><label class="field">项目名称<input name="name" maxlength="100" placeholder="例如：H3 LoRA 训练" required></label>${footer("创建项目")}</form>`,
  );
}
function newRecord() {
  if (!state.projects.length) {
    newProject();
    $("#project-form").dataset.continue = "record";
    return;
  }
  modal(
    "新建笔记本",
    `<form id="new-record-form"><label class="field">笔记本标题<input name="title" maxlength="300" placeholder="例如：第 1 次训练 · 建立基线" required></label><label class="field">所属项目<select name="project_id">${state.projects.map((p) => `<option value="${p.id}" ${project === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label><label class="field">从模板开始<select name="template">${state.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select></label><p class="modal-info">创建后直接开始写。模板中的参数会收在可折叠的属性区。</p>${footer("创建笔记本")}</form>`,
  );
}
function projectSettings() {
  const p = state.projects.find((p) => p.id === project);
  if (!p) return;
  modal(
    "项目设置",
    `<form id="project-settings-form"><label class="field">项目名称<input name="name" value="${esc(p.name)}" maxlength="100" required></label><label class="field">所属工作空间<select name="workspace_id">${state.workspaces.map((w) => `<option value="${esc(w.id)}" ${w.id === workspace ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label><p class="hint">这个项目中有 ${state.records.filter((r) => r.project_id === p.id).length} 条记录。</p><button class="button danger" type="button" data-action="delete-project">删除项目及其全部记录</button>${footer("保存修改")}</form>`,
  );
}
function compare() {
  const r = current();
  if (!r) return;
  const others = state.records.filter((x) => x.id !== r.id);
  if (!others.length)
    return toast("需要至少两条记录才能对比。你可以先复制当前记录。");
  modal(
    "记录对比",
    `<p class="hint">对比的是已经保存的内容；淡黄色标出不同之处。</p><div class="compare-controls"><select id="compare-other" aria-label="选择对比记录">${others.map((o) => `<option value="${o.id}" ${r.related_id === o.id ? "selected" : ""}>${esc(o.title)}</option>`).join("")}</select></div><div id="comparison"></div>`,
    true,
  );
  renderComparison();
}
function renderComparison() {
  const a = current(),
    b = state.records.find((r) => r.id === $("#compare-other").value);
  if (!a || !b) return;
  const rows = [
    [
      "正文",
      a.cells.map((c) => c.source).join("\n\n"),
      b.cells.map((c) => c.source).join("\n\n"),
    ],
    ["状态", a.status, b.status],
    ["目标", a.goal, b.goal],
    ...[...new Set([...Object.keys(a.params), ...Object.keys(b.params)])].map(
      (k) => [k, a.params[k], b.params[k]],
    ),
    ["结果", a.result, b.result],
    ["结论", a.conclusion, b.conclusion],
    ["下一步", a.next_step, b.next_step],
  ];
  $("#comparison").innerHTML =
    `<table class="compare-table"><thead><tr><th>字段</th><th>${esc(a.title)}</th><th>${esc(b.title)}</th></tr></thead><tbody>${rows.map(([k, a, b]) => `<tr class="${a !== b ? "changed" : ""}"><th>${esc(k)}</th><td>${esc(a || "—")}</td><td>${esc(b || "—")}</td></tr>`).join("")}</tbody></table>`;
}
function templates() {
  templateWork = structuredClone(state.templates);
  templateIndex = 0;
  renderTemplates();
}
function renderTemplates() {
  const t = templateWork[templateIndex];
  modal(
    "记录模板",
    `<div class="template-tabs">${templateWork.map((t, i) => `<button class="button small ${i === templateIndex ? "active" : ""}" data-action="template-select" data-index="${i}">${esc(t.name)}</button>`).join("")}<button class="button small" data-action="template-add">＋</button></div><form id="template-form" class="template-edit"><label class="field">模板名称<input name="name" required maxlength="80" value="${esc(t.name)}"></label><label class="field">默认目标<textarea name="goal">${esc(t.goal)}</textarea></label><label class="field">参数字段（每行一项，可用 = 设置默认值）<textarea name="params" placeholder="学习率=0.0001&#10;随机种子=42">${esc(
      Object.entries(t.params)
        .map(([k, v]) => k + (v ? "=" + v : ""))
        .join("\n"),
    )}</textarea></label><p class="hint">修改只影响之后创建的记录。</p><button class="text-button danger" type="button" data-action="template-delete">删除此模板</button>${footer("保存全部模板")}</form>`,
  );
}
function collectTemplate() {
  const data = Object.fromEntries(new FormData($("#template-form"))),
    params = {};
  for (const line of data.params.split("\n").filter((l) => l.trim())) {
    const pos = line.indexOf("="),
      k = (pos < 0 ? line : line.slice(0, pos)).trim(),
      v = pos < 0 ? "" : line.slice(pos + 1);
    if (!k || Object.hasOwn(params, k))
      throw new Error("模板参数名称不能为空或重复");
    Object.defineProperty(params, k, {
      value: v,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  templateWork[templateIndex] = {
    ...templateWork[templateIndex],
    name: data.name,
    goal: data.goal,
    params,
  };
}
async function download(path) {
  const response = await fetch("/api" + path);
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "导出失败");
  }
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download =
    path === "/backup"
      ? "过程簿备份-" +
        new Date().toISOString().slice(0, 10) +
        (response.headers.get("Content-Type")?.includes("application/zip")
          ? ".zip"
          : ".plbackup")
      : (current()?.title || "记录").replace(/[\\/:*?"<>|]/g, "_") + ".md";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(
    path === "/backup" ? "完整备份已生成，已开始下载" : "已导出保存后的记录",
  );
}
async function act(action, el) {
  switch (action) {
    case "focus-mode":
      document.body.classList.toggle("focus-mode");
      el.setAttribute(
        "aria-pressed",
        String(document.body.classList.contains("focus-mode")),
      );
      el.textContent = document.body.classList.contains("focus-mode")
        ? "退出专注"
        : "专注模式";
      return;
    case "close-navigation":
      document.body.classList.remove("navigation-open");
      $("[data-action=navigation]").setAttribute("aria-expanded", "false");
      return;
    case "navigation":
      document.body.classList.toggle("navigation-open");
      el.setAttribute(
        "aria-expanded",
        String(document.body.classList.contains("navigation-open")),
      );
      return;
    case "back-list":
      document.body.classList.remove("reading-note", "focus-mode");
      $("[data-action=focus-mode]").textContent = "专注模式";
      $("[data-action=focus-mode]").setAttribute("aria-pressed", "false");
      return;
    case "new-workspace":
      return modal(
        "新建工作空间",
        `<form id="workspace-form"><label class="field">名称<input name="name" maxlength="100" required placeholder="例如：模型训练、工作流研究"></label>${footer("创建")}</form>`,
      );
    case "workspace-settings":
      return modal(
        "工作空间设置",
        `<form id="workspace-settings-form"><label class="field">名称<input name="name" maxlength="100" value="${esc(state.workspaces.find((w) => w.id === workspace)?.name)}" required></label><p class="hint">模板共用；完整备份包含所有工作空间。删除空间前需先移出项目。</p>${workspace !== "default" ? '<button type="button" class="button danger" data-action="delete-workspace">删除空工作空间</button>' : ""}${footer("保存")}</form>`,
      );
    case "delete-workspace":
      if (confirm("删除这个空工作空间？")) {
        await api("/workspaces/" + workspace, "DELETE");
        workspace = "default";
        writeLocal("process-log:workspace", workspace);
        $("#modal").close();
        await refresh();
      }
      return;

    case "new-project":
      return newProject();
    case "new-record":
      return newRecord();
    case "project":
      document.body.classList.remove("navigation-open");
      project = el.dataset.id;
      selected = "";
      dirty = false;
      renderNav();
      renderList();
      renderDetail();
      return;
    case "select":
      return selectRecord(el.dataset.id);
    case "project-settings":
      return projectSettings();
    case "close-modal":
      return $("#modal").close();
    case "duplicate": {
      const copy = await api("/records/" + selected + "/duplicate", "POST", {});
      await refresh(false);
      selectRecord(copy.id);
      toast("已复制已保存的目标和参数，并关联原记录");
      return;
    }
    case "compare":
      return compare();
    case "export":
      return download("/records/" + selected + "/markdown");
    case "backup":
      return download("/backup");
    case "restore":
      modal(
        "从备份恢复",
        `<p class="muted">恢复会替换当前全部项目、记录和模板。工具会先检查备份，并自动保存一份恢复前的完整备份。</p><p class="modal-info">支持过程簿 ZIP 和加密备份 .plbackup，解压后不超过 250 MB。加密备份须在配置相同密钥的服务器恢复。未保存的草稿不包含在备份中，请先保存。</p><div class="modal-footer"><button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="pick-restore">选择备份文件</button></div>`,
      );
      return;
    case "pick-restore":
      $("#restore-picker").click();
      return;
    case "delete-record":
      if (
        confirm(
          "删除「" +
            current().title +
            "」及其时间线和附件？建议先导出完整备份。",
        )
      ) {
        const id = selected;
        await api("/records/" + id, "DELETE");
        writeLocal(draftKey(id), null);
        writeLocal(entryKey(id), null);
        selected = "";
        await refresh();
        toast("记录已删除");
      }
      return;
    case "delete-project":
      if (confirm("确定删除这个项目和其中的全部记录？此操作不可撤销。")) {
        await api("/projects/" + project, "DELETE");
        project = "";
        selected = "";
        $("#modal").close();
        await refresh();
        toast("项目已删除");
      }
      return;
    case "templates":
      return templates();
    case "template-select":
      collectTemplate();
      templateIndex = Number(el.dataset.index);
      renderTemplates();
      return;
    case "template-add":
      collectTemplate();
      templateWork.push({ id: newId(), name: "新模板", goal: "", params: {} });
      templateIndex = templateWork.length - 1;
      renderTemplates();
      return;
    case "template-delete":
      if (templateWork.length === 1) return toast("至少保留一个模板", true);
      if (confirm("删除此模板？现有记录不受影响。")) {
        templateWork.splice(templateIndex, 1);
        templateIndex = 0;
        renderTemplates();
      }
      return;
  }
}
document.addEventListener("click", async (event) => {
  document.querySelectorAll(".note-menu[open]").forEach((menu) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  const el = event.target.closest("[data-action]");
  if (!el) return;
  if (busy) return toast("正在保存，请稍候");
  busy = true;
  try {
    if (
      ![
        "close-modal",
        "template-select",
        "template-add",
        "template-delete",
      ].includes(el.dataset.action)
    )
      await notebook?.flush();
    await act(el.dataset.action, el);
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "search") renderList();
});
document.addEventListener("change", async (event) => {
  if (event.target.id === "workspace-select") {
    const next = event.target.value;
    if (busy) {
      event.target.value = workspace;
      return;
    }
    busy = true;
    try {
      await notebook?.flush();
      workspace = next;
      writeLocal("process-log:workspace", workspace);
      project = "";
      selected = "";
      $("#search").value = "";
      $("#status-filter").value = "";
      $("#tag-filter").value = "";
      await refresh();
      document.body.classList.remove("navigation-open", "reading-note");
    } catch (e) {
      event.target.value = workspace;
      toast(e.message, true);
    } finally {
      busy = false;
    }
    return;
  }
  if (["status-filter", "tag-filter"].includes(event.target.id)) renderList();
  if (event.target.id === "compare-other") renderComparison();
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.target,
    submit = $("[type=submit]", form),
    data = Object.fromEntries(new FormData(form));
  if (!form.reportValidity()) return;
  busy = true;
  form.inert = true;
  if (submit) submit.disabled = true;
  try {
    switch (form.id) {
      case "workspace-form": {
        const w = await api("/workspaces", "POST", data);
        workspace = w.id;
        writeLocal("process-log:workspace", workspace);
        project = "";
        selected = "";
        $("#modal").close();
        await refresh();
        break;
      }
      case "workspace-settings-form":
        await api("/workspaces/" + workspace, "PUT", data);
        $("#modal").close();
        await refresh(false);
        break;
      case "project-form": {
        const p = await api("/projects", "POST", {
          ...data,
          workspace_id: workspace,
        });
        project = p.id;
        $("#modal").close();
        await refresh();
        if (form.dataset.continue) newRecord();
        break;
      }
      case "project-settings-form":
        await api("/projects/" + project, "PUT", data);
        $("#modal").close();
        await refresh();
        toast("项目已更新");
        break;
      case "new-record-form": {
        const t = state.templates.find((t) => t.id === data.template);
        const r = await api("/records", "POST", {
          ...data,
          goal: t?.goal || "",
          params: t?.params || {},
        });
        project = r.project_id;
        $("#modal").close();
        await refresh(false);
        selectRecord(r.id);
        break;
      }
      case "template-form":
        collectTemplate();
        await api("/templates", "PUT", { templates: templateWork });
        $("#modal").close();
        await refresh(false);
        toast("模板已保存");
        break;
    }
  } catch (e) {
    const error = $(".modal-error", form);
    if (error) {
      error.textContent = e.message;
      error.hidden = false;
    } else toast(e.message, true);
  } finally {
    busy = false;
    form.inert = false;
    if (submit) submit.disabled = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document
      .querySelectorAll(".note-menu[open]")
      .forEach((menu) => (menu.open = false));
    document.body.classList.remove("navigation-open");
    $("[data-action=navigation]").setAttribute("aria-expanded", "false");
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!$("#modal").open && !busy)
      notebook?.flush().catch((e) => toast(e.message, true));
  }
});
$("#restore-picker").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 250 * 1024 * 1024) return toast("备份不能超过 250 MB", true);
  if (!confirm("使用「" + file.name + "」替换当前全部数据？")) return;
  busy = true;
  try {
    const beforeRestore = await api("/state");
    const response = await fetch("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-Process-Log": "1" },
      body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    for (const r of beforeRestore.records) {
      writeLocal(draftKey(r.id), null);
      writeLocal(entryKey(r.id), null);
      writeLocal("process-log:notebook:" + r.id, null);
    }
    selected = "";
    project = "";
    dirty = false;
    $("#modal").close();
    await refresh();
    toast("备份已恢复，恢复前的数据也已自动备份");
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
  }
});
window.addEventListener("beforeunload", (event) => {
  if (notebook?.dirty || notebook?.uploading || busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("#today").textContent = new Date().toLocaleDateString("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});
refresh().catch((e) => {
  toast(e.message, true);
  $("#detail").innerHTML =
    '<div class="empty"><h2>暂时无法读取记录</h2><p>请确认本地服务正在运行，然后刷新页面重试。</p></div>';
});
