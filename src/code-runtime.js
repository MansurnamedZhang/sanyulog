import { createLowlight, common } from "lowlight";
import powershell from "highlight.js/lib/languages/powershell";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";

const engine = createLowlight({ ...common, powershell, dockerfile, nginx });
const plain = (text) => ({
  type: "root",
  children: [{ type: "text", value: text }],
});
// Bound parsing costs for pasted logs/generated files. Keep all original text.
const limited = (text) =>
  text.length > 40000 || text.split("\n").some((line) => line.length > 4000);
export const highlighter = {
  listLanguages: () => engine.listLanguages(),
  registered: (language) => engine.registered(language),
  highlight(language, text) {
    if (language === "mermaid" || limited(text) || !engine.registered(language))
      return plain(text);
    try {
      return engine.highlight(language, text);
    } catch {
      return plain(text);
    }
  },
  // Unlabelled/unknown blocks stay neutral; guessing also adds work on each edit.
  highlightAuto: plain,
};
export function highlightCode(text, language) {
  text = String(text ?? "");
  const escape = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const serialize = (node) =>
    node.type === "text"
      ? escape(node.value)
      : node.type === "root"
        ? node.children.map(serialize).join("")
        : `<span class="${(node.properties?.className || []).join(" ")}">${(node.children || []).map(serialize).join("")}</span>`;
  return serialize(highlighter.highlight(language, text));
}
