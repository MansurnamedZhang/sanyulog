import { highlightCode, highlighter } from "./vendor/code-runtime.mjs";
export { highlighter };
export const codeLanguages = [
  ["plaintext", "纯文本"],
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["bash", "Shell / Bash"],
  ["powershell", "PowerShell"],
  ["json", "JSON"],
  ["yaml", "YAML"],
  ["ini", "INI / TOML"],
  ["sql", "SQL"],
  ["xml", "HTML / XML"],
  ["css", "CSS"],
  ["scss", "SCSS"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["java", "Java"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["kotlin", "Kotlin"],
  ["swift", "Swift"],
  ["php", "PHP"],
  ["ruby", "Ruby"],
  ["lua", "Lua"],
  ["r", "R"],
  ["dockerfile", "Dockerfile"],
  ["nginx", "Nginx"],
  ["markdown", "Markdown"],
  ["diff", "Diff"],
  ["graphql", "GraphQL"],
];
const aliases = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ps1: "powershell",
  ps: "powershell",
  yml: "yaml",
  html: "xml",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  rs: "rust",
  golang: "go",
  docker: "dockerfile",
  toml: "ini",
  md: "markdown",
  text: "plaintext",
  txt: "plaintext",
  none: "plaintext",
};
export const escapeCode = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
export function codeLanguage(value) {
  const name = String(value || "plaintext")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
  return Object.hasOwn(aliases, name) ? aliases[name] : name || "plaintext";
}
export function languageOptions(value) {
  const current = codeLanguage(value);
  const items = codeLanguages.some(([id]) => id === current)
    ? codeLanguages
    : [[current, current], ...codeLanguages];
  return items
    .map(
      ([id, label]) =>
        `<option value="${escapeCode(id)}"${id === current ? " selected" : ""}>${escapeCode(label)}</option>`,
    )
    .join("");
}
export function renderCodeBlock(source, language, { controls = true } = {}) {
  const name = codeLanguage(language);
  const label = codeLanguages.find(([id]) => id === name)?.[1] || name;
  return `<div class="nb-code-block${controls ? "" : " is-wrapped"}" data-code-language="${escapeCode(name)}"><div class="nb-code-toolbar"><span class="nb-code-label">${escapeCode(label)}</span>${controls ? '<div class="nb-code-actions"><button type="button" data-code-action="wrap" aria-pressed="false">自动换行</button><button type="button" data-code-action="copy">复制代码</button></div>' : ""}</div><pre><code class="hljs language-${escapeCode(name)}">${highlightCode(source, name)}</code></pre></div>`;
}
export async function copyCodeText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* LAN HTTP fallback */
    }
  }
  const focused = document.activeElement;
  const domSelection = window.getSelection();
  const ranges = Array.from({ length: domSelection?.rangeCount || 0 }, (_, i) =>
    domSelection.getRangeAt(i).cloneRange(),
  );
  const selection =
    focused?.selectionStart != null
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  Object.assign(area.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    if (!document.execCommand("copy"))
      throw new Error("无法复制，请允许浏览器访问剪贴板后重试");
  } finally {
    area.remove();
    focused?.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
    else if (domSelection) {
      domSelection.removeAllRanges();
      for (const range of ranges) domSelection.addRange(range);
    }
  }
}
export async function codeBlockAction(button, source) {
  const block = button.closest(".nb-code-block");
  if (!block) return;
  if (button.dataset.codeAction === "wrap") {
    const wrapped = block.classList.toggle("is-wrapped");
    button.setAttribute("aria-pressed", String(wrapped));
    return;
  }
  await copyCodeText(source ?? block.querySelector("code").textContent);
  button.textContent = "已复制";
  setTimeout(() => {
    if (button.isConnected) button.textContent = "复制代码";
  }, 1400);
}
