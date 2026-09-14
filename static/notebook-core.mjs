import katex from "./vendor/katex.mjs";

export function parseCSV(text, delimiter = ",") {
  text = String(text)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const rows = [],
    row = [];
  let value = "",
    quoted = false,
    closed = false;
  const push = () => {
    row.push(value);
    value = "";
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += ch;
      continue;
    }
    if (ch === delimiter || ch === "\n") {
      push();
      if (ch === "\n") rows.push(row.splice(0));
      continue;
    }
    if (closed) throw new Error("CSV 引号结束后必须是分隔符或换行");
    if (ch === '"') {
      if (value) throw new Error("CSV 字段中的引号需要成对转义");
      quoted = true;
    } else value += ch;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  if (value || row.length || closed) {
    push();
    rows.push(row);
  }
  if (!rows.length) rows.push([""]);
  if (rows.length > 1001 || Math.max(...rows.map((r) => r.length)) > 50)
    throw new Error("独立表格最多 1000 行数据、50 列");
  return rows;
}
export function serializeCSV(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          value = String(value);
          return /[,"\r\n]/.test(value)
            ? '"' + value.replaceAll('"', '""') + '"'
            : value;
        })
        .join(","),
    )
    .join("\r\n");
}

export function createTable(rows = 3, columns = 3) {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    rows > 100 ||
    columns < 1 ||
    columns > 20
  )
    throw new Error("表格需要 1–100 行数据、1–20 列");
  const line = (items) => "| " + items.join(" | ") + " |";
  return (
    "\n\n" +
    [
      line(Array.from({ length: columns }, (_, i) => "列 " + (i + 1))),
      line(Array(columns).fill("---")),
      ...Array.from({ length: rows }, () => line(Array(columns).fill(""))),
    ].join("\n") +
    "\n\n"
  );
}

export function tsvToTable(text) {
  if (!text.includes("\t")) return null;
  const rows = [],
    row = [];
  let value = "",
    quoted = false;
  text = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (quoted || !value)) {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === "\t" || ch === "\n")) {
      row.push(value);
      value = "";
      if (ch === "\n") {
        rows.push(row.splice(0));
      }
    } else value += ch;
  }
  if (quoted) return null;
  if (value || row.length) row.push(value);
  if (row.length) rows.push(row);
  const columns = Math.max(0, ...rows.map((r) => r.length));
  if (columns < 2 || columns > 20 || rows.length > 101) return null;
  const encode = (value) =>
    value.replace(
      /[&<>|\\*_[\]~`$\n]/g,
      (ch) => "&#" + ch.codePointAt(0) + ";",
    );
  const line = (row) =>
    "| " +
    Array.from({ length: columns }, (_, i) => encode(row[i] ?? "")).join(
      " | ",
    ) +
    " |";
  return (
    "\n\n" +
    [
      line(rows[0]),
      "| " + Array(columns).fill("---").join(" | ") + " |",
      ...rows.slice(1).map(line),
    ].join("\n") +
    "\n\n"
  );
}

function formatListLines(text, start, end, tool) {
  start = Math.max(0, Math.min(start, text.length));
  end = Math.max(start, Math.min(end, text.length));
  const first = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const lastSelected = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const next = text.indexOf("\n", lastSelected),
    last = next < 0 ? text.length : next;
  const counts = new Map();
  const replacement = text
    .slice(first, last)
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const match = line.match(/^([ \t]*)(?:(?:[-+*]|\d+[.)])\s+)?(.*)$/),
        indent = match[1],
        value = match[2];
      if (tool === "outdent") return line.replace(/^(?: {1,4}|\t)/, "");
      if (tool === "indent")
        return (
          "    " +
          indent +
          (/^(?:[-+*]|\d+[.)])\s+/.test(line.slice(indent.length))
            ? line.slice(indent.length)
            : "- " + value)
        );
      const depth = indent.replace(/\t/g, "    ").length;
      for (const key of counts.keys()) if (key > depth) counts.delete(key);
      const number = (counts.get(depth) || 0) + 1;
      counts.set(depth, number);
      return indent + (tool === "ordered" ? number + ". " : "- ") + value;
    })
    .join("\n");
  if (
    !replacement &&
    ["ordered", "unordered", "list", "indent"].includes(tool)
  ) {
    const prefix =
        tool === "ordered" ? "1. " : tool === "indent" ? "    - " : "- ",
      value = prefix + "列表项";
    return {
      text: text.slice(0, first) + value + text.slice(last),
      start: first + prefix.length,
      end: first + value.length,
    };
  }
  return {
    text: text.slice(0, first) + replacement + text.slice(last),
    start: first,
    end: first + replacement.length,
  };
}

export function formatSelection(text, start, end, tool) {
  if (["list", "unordered", "ordered", "indent", "outdent"].includes(tool))
    return formatListLines(text, start, end, tool);
  const formats = {
    bold: ["**", "**", "加粗文字"],
    italic: ["*", "*", "斜体文字"],
    code: ["`", "`", "code"],
    codeblock: ["\n```\n", "\n```\n", "代码"],
    math: ["$", "$", "x^2"],
    mathblock: ["\n$$\n", "\n$$\n", "\\frac{a}{b}"],
    heading: ["## ", "", "标题"],
    list: ["- ", "", "列表项"],
  };
  let [before, after, placeholder] = formats[tool] || formats.bold;
  const selected = text.slice(start, end) || placeholder;
  if (tool === "code" || tool === "codeblock") {
    const fence = "`".repeat(
      Math.max(
        tool === "code" ? 1 : 3,
        ...(selected.match(/`+/g) || []).map((s) => s.length + 1),
      ),
    );
    before = tool === "code" ? fence : "\n" + fence + "\n";
    after = tool === "code" ? fence : "\n" + fence + "\n";
  }
  return {
    text: text.slice(0, start) + before + selected + after + text.slice(end),
    start: start + before.length,
    end: start + before.length + selected.length,
  };
}

function mathHTML(source, displayMode = false) {
  try {
    if (source.length > 10000) throw new Error("formula too long");
    return katex.renderToString(source, {
      displayMode,
      output: "mathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 20,
    });
  } catch {
    return (
      '<span class="nb-math-error" title="公式语法无效或暂不支持，请点击编辑">' +
      escapeHTML(source) +
      "</span>"
    );
  }
}

export function newId(provider = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  provider.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function inline(source) {
  const tokens = [];
  const token = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let raw = source.replace(/\u0000/g, "");
  raw = raw.replace(/(`+)(.+?)\1/g, (_, fence, code) =>
    token("<code>" + escapeHTML(code) + "</code>"),
  );
  raw = raw.replace(/\\\$/g, () => token("$"));
  raw = raw.replace(/\\\((.+?)\\\)|\$(?!\$)([^\n$]+?)\$/g, (_, paren, dollar) =>
    token(mathHTML(paren ?? dollar)),
  );
  let text = escapeHTML(raw);
  text = text.replace(/!?\[([^\]]*)\]\(([^\s)]+)\)/g, (_, label, url) => {
    const safe = /^(https?:\/\/|mailto:)/i.test(url);
    return token(
      safe
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>`
        : label || url,
    );
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
}

export function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n"),
    html = [];
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((x) => x.trim().replace(/\\\|/g, "|"));
  const tableInline = (value) =>
    inline(value)
      .replace(/&amp;#10;/g, "<br>")
      .replace(/&amp;#(\d+);/g, "&#$1;");
  const tableSeparator = (line) =>
    line.includes("|") && cells(line).every((c) => /^:?-{3,}:?$/.test(c));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const code = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(
          "^\\s*" + fence[1][0] + "{" + fence[1].length + ",}\\s*$",
        ).test(lines[i])
      )
        code.push(lines[i++]);
      if (i < lines.length) i++;
      html.push("<pre><code>" + escapeHTML(code.join("\n")) + "</code></pre>");
      continue;
    }
    if (line.trim().startsWith("$$") || line.trim().startsWith("\\[")) {
      const close = line.trim().startsWith("$$") ? "$$" : "\\]",
        parts = [];
      let j = i,
        rest = line.trim().slice(2),
        closed = false;
      while (true) {
        const end = rest.indexOf(close);
        if (end >= 0) {
          parts.push(rest.slice(0, end));
          if (rest.slice(end + 2).trim()) break;
          closed = true;
          break;
        }
        parts.push(rest);
        j++;
        if (j >= lines.length) break;
        rest = lines[j];
      }
      if (closed) {
        html.push(
          '<div class="nb-math-display">' +
            mathHTML(parts.join("\n"), true) +
            "</div>",
        );
        i = j + 1;
        continue;
      }
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      html.push(
        `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`,
      );
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }
    if (
      i + 1 < lines.length &&
      line.includes("|") &&
      tableSeparator(lines[i + 1])
    ) {
      const headers = cells(line);
      html.push(
        '<div class="nb-table-scroll"><table><thead><tr>' +
          headers.map((c) => "<th>" + tableInline(c) + "</th>").join("") +
          "</tr></thead><tbody>",
      );
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        html.push(
          "<tr>" +
            cells(lines[i++])
              .map((c) => "<td>" + tableInline(c) + "</td>")
              .join("") +
            "</tr>",
        );
      }
      html.push("</tbody></table></div>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        quote.push(inline(lines[i++].replace(/^\s*>\s?/, "")));
      html.push("<blockquote>" + quote.join("<br>") + "</blockquote>");
      continue;
    }
    const listMatch = (value) =>
      value.match(/^([ \t]*)(?:([-+*])|(\d+)[.)])\s+(.*)$/);
    if (listMatch(line)) {
      const stack = [];
      const close = () => {
        const previous = stack.pop();
        html.push("</li></" + previous.tag + ">");
      };
      while (i < lines.length) {
        if (!lines[i].trim()) {
          let next = i + 1;
          while (next < lines.length && !lines[next].trim()) next++;
          if (next < lines.length && listMatch(lines[next])) {
            i = next;
            continue;
          }
          break;
        }
        const item = listMatch(lines[i]);
        if (!item) break;
        const depth = item[1].replace(/\t/g, "    ").length,
          tag = item[3] ? "ol" : "ul";
        while (stack.length && depth < stack.at(-1).depth) close();
        if (
          stack.length &&
          depth === stack.at(-1).depth &&
          tag !== stack.at(-1).tag
        )
          close();
        if (!stack.length || depth > stack.at(-1).depth) {
          html.push(
            "<" +
              tag +
              (tag === "ol" && Number(item[3]) !== 1
                ? ' start="' + Number(item[3]) + '"'
                : "") +
              ">",
          );
          stack.push({ depth, tag });
        } else html.push("</li>");
        html.push(
          "<li>" +
            inline(item[4]).replace(/^\[([ xX])\] /, (_, x) =>
              x === " " ? "☐ " : "☑ ",
            ),
        );
        i++;
      }
      while (stack.length) close();
      continue;
    }
    const paragraph = [inline(line)];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*(`{3,}|~{3,}|>|[-+*]\s|\d+[.)]\s|\$\$|\\\[))/.test(
        lines[i],
      ) &&
      !(i + 1 < lines.length && tableSeparator(lines[i + 1]))
    ) {
      paragraph.push(inline(lines[i++]));
    }
    html.push("<p>" + paragraph.join("<br>") + "</p>");
  }
  return html.join("");
}

/** Snapshot queue: edits received during a request are saved with the returned version. */
export class Autosave {
  constructor({
    initial,
    save,
    persist = () => {},
    onStatus = () => {},
    delay = 800,
  }) {
    this.data = structuredClone(initial);
    this.save = save;
    this.persist = persist;
    this.onStatus = onStatus;
    this.delay = delay;
    this.revision = 0;
    this.savedRevision = 0;
    this.timer = null;
    this.task = null;
    this.blocked = null;
  }
  get dirty() {
    return this.revision !== this.savedRevision;
  }
  change(patch) {
    Object.assign(this.data, structuredClone(patch));
    this.revision++;
    this.persist(structuredClone(this.data));
    clearTimeout(this.timer);
    this.onStatus(this.blocked ? "error" : "pending", this.blocked);
    if (!this.blocked)
      this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.blocked) throw this.blocked;
    if (this.task) return this.task;
    this.task = this.drain();
    try {
      return await this.task;
    } finally {
      this.task = null;
    }
  }
  async drain() {
    while (this.dirty) {
      const revision = this.revision,
        snapshot = structuredClone(this.data);
      this.onStatus("saving");
      try {
        const saved = await this.save(snapshot);
        this.data.version = saved.version;
        this.savedRevision = revision;
        this.persist(this.dirty ? structuredClone(this.data) : null);
      } catch (error) {
        if (error.status === 409) this.blocked = error;
        this.persist(structuredClone(this.data));
        this.onStatus("error", error);
        throw error;
      }
    }
    this.onStatus("saved");
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
