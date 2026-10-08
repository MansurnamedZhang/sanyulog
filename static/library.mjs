import { escapeHTML } from "./notebook-core.mjs";

export class RecordSearch {
  constructor() {
    this.cache = new WeakMap();
  }
  matches(record, query) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    let text = this.cache.get(record);
    if (text === undefined) {
      text = [
        record.title,
        record.goal,
        Object.entries(record.params || {}).flat(),
        record.tags,
        record.result,
        record.conclusion,
        record.next_step,
        record.cells?.map((cell) => cell.source),
        record.attachments?.map((attachment) => attachment.name),
      ]
        .flat()
        .join("\n")
        .toLocaleLowerCase();
      this.cache.set(record, text);
    }
    return terms.every((term) => text.includes(term));
  }
}

export function recordExcerpt(record) {
  return (
    record.cells?.find((cell) => cell.source.trim())?.source ||
    record.goal ||
    "空白笔记本，从一个单元格开始。"
  )
    .slice(0, 600)
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function normalizeView(value) {
  return {
    density: value?.density === "compact" ? "compact" : "comfortable",
    textSize: ["small", "normal", "large"].includes(value?.textSize)
      ? value.textSize
      : "normal",
  };
}

export class RecordList {
  constructor(root) {
    this.root = root;
    this.cards = new Map();
    root.replaceChildren();
  }
  render(records, selected, projects, emptyText) {
    const position = this.root.scrollTop,
      keep = new Set(records.map((r) => r.id));
    for (const [id, card] of this.cards) {
      if (!keep.has(id)) {
        card.remove();
        this.cards.delete(id);
      }
    }
    this.root.querySelector(".library-empty")?.remove();
    let cursor = this.root.firstElementChild;
    const names = new Map(projects.map((p) => [p.id, p.name]));
    for (const record of records) {
      let card = this.cards.get(record.id);
      if (!card) {
        card = document.createElement("button");
        card.className = "record-card";
        card.dataset.action = "select";
        card.dataset.id = record.id;
        this.cards.set(record.id, card);
      }
      const signature = record,
        projectName = names.get(record.project_id) || "";
      if (card.record !== signature || card.projectName !== projectName) {
        const status =
          { 已完成: "done", 受阻: "blocked", 已搁置: "paused" }[
            record.status
          ] || "";
        card.innerHTML = `<div class="card-top"><span class="status ${status}">${escapeHTML(record.status)}</span><time>${new Date(record.updated).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</time></div><h3>${escapeHTML(record.title)}</h3><p class="card-excerpt">${escapeHTML(recordExcerpt(record))}</p><div class="card-bottom"><span>${record.tags.length ? "# " + escapeHTML(record.tags.slice(0, 2).join(" · ")) : escapeHTML(projectName)}</span><span>${record.cells?.length || 0} 个单元</span></div>`;
        card.record = signature;
        card.projectName = projectName;
      }
      card.classList.toggle("active", record.id === selected);
      card.setAttribute("aria-pressed", String(record.id === selected));
      if (card !== cursor) this.root.insertBefore(card, cursor);
      cursor = card.nextElementSibling;
    }
    if (!records.length) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.innerHTML = `<span aria-hidden="true">⌕</span><p>${escapeHTML(emptyText)}</p>`;
      this.root.append(empty);
    }
    this.root.scrollTop = position;
  }
}
