import { escapeHTML, parseCSV, renderMarkdown } from "./notebook-core.mjs";

const labels = {
  markdown: "文本",
  code: "代码",
  log: "日志",
  file: "附件",
  table: "表格数据",
};
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const safe = (value) => escapeHTML(String(value ?? ""));
const paragraph = (value) => safe(value).replace(/\r?\n/g, "<br>");

function attachmentsHTML(ids, attachments) {
  return ids
    .map((id) => attachments.find((item) => item.id === id))
    .filter(Boolean)
    .map((item) => {
      const url = `/api/attachments/${encodeURIComponent(item.id)}`;
      const media = ["video/mp4", "video/webm"].includes(item.mime)
        ? "video"
        : ["audio/mpeg", "audio/ogg", "audio/wav"].includes(item.mime)
          ? "audio"
          : "";
      const preview = imageTypes.has(item.mime)
        ? `<img src="${url}?preview=1" alt="${safe(item.name)}">`
        : media
          ? `<${media} class="nb-media-preview" controls preload="metadata" src="${url}?preview=1" aria-label="${safe(item.name)}"></${media}>`
          : "";
      return `<div class="nb-export-attachment">${preview}<a href="${url}">${safe(item.name)}</a></div>`;
    })
    .join("");
}

function tableHTML(source) {
  try {
    const [head, ...body] = parseCSV(source);
    if (!head?.length) return "";
    const row = (cells, tag) =>
      `<tr>${cells.map((value) => `<${tag}>${paragraph(value)}</${tag}>`).join("")}</tr>`;
    return `<table class="nb-export-table"><thead>${row(head, "th")}</thead><tbody>${body.map((cells) => row(cells, "td")).join("")}</tbody></table>`;
  } catch {
    return `<pre>${safe(source)}</pre>`;
  }
}

export function renderNotebookHTML(
  notebook,
  attachments = [],
  relatedTitle = "",
) {
  const data = notebook || {};
  const fields = [
    ["状态", data.status],
    ["标签", (data.tags || []).join("，")],
    ["目标", data.goal],
    ["结果", data.result],
    ["结论", data.conclusion],
    ["下一步", data.next_step],
    ["关联记录", relatedTitle],
  ].filter(([, value]) => value != null && String(value).trim());
  const properties = fields.length
    ? `<dl class="nb-export-properties">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${paragraph(value)}</dd></div>`).join("")}</dl>`
    : "";
  const params = Object.entries(data.params || {});
  const config = params.length
    ? `<section class="nb-export-config"><h2>参数与配置</h2><dl class="nb-export-properties">${params.map(([key, value]) => `<div><dt>${safe(key)}</dt><dd>${paragraph(value)}</dd></div>`).join("")}</dl></section>`
    : "";
  const cells = (data.cells || [])
    .map((cell, index) => {
      let body = "";
      if (cell.type === "markdown") body = renderMarkdown(cell.source || "");
      else if (cell.type === "table") body = tableHTML(cell.source || "");
      else if (cell.type === "code" || cell.type === "log")
        body = `<pre><code>${safe(cell.source || "")}</code></pre>`;
      const attached = attachmentsHTML(cell.attachment_ids || [], attachments);
      return `<section class="nb-export-cell"><h2 class="nb-export-cell-heading">${String(index + 1).padStart(2, "0")} · ${labels[cell.type] || "内容"}${cell.type === "code" && cell.language ? ` <small>${safe(cell.language)}</small>` : ""}</h2>${body}${attached}</section>`;
    })
    .join("");
  const usedIds = new Set(
    (data.cells || []).flatMap((cell) => cell.attachment_ids || []),
  );
  const remaining = attachments.filter((item) => !usedIds.has(item.id));
  const library = remaining.length
    ? `<section class="nb-export-cell"><h2>其他附件</h2>${attachmentsHTML(
        remaining.map((item) => item.id),
        attachments,
      )}</section>`
    : "";
  return `<div class="nb-export-notebook"><h1>${safe(data.title || "未命名笔记本")}</h1>${properties}${config}${cells}${library}</div>`;
}
