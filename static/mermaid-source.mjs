// Pasted HTML often uses a character reference for indentation. Mermaid
// expects actual whitespace before a statement. Leave entities inside labels alone.
export function normalizeMermaidDefinition(source) {
  return source.replace(/^([ \t]*)&#(?:x20|32);/gim, "$1 ");
}

export function normalizeMermaidFences(markdown) {
  const lines = markdown.split(/(\r?\n)/);
  let fence = null;
  for (let i = 0; i < lines.length; i += 2) {
    if (!fence) {
      fence =
        lines[i].match(/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i)?.[1] ||
        null;
    } else if (
      new RegExp(`^[ \t]*${fence[0]}{${fence.length},}[ \t]*$`).test(lines[i])
    ) {
      fence = null;
    } else {
      lines[i] = normalizeMermaidDefinition(lines[i]);
    }
  }
  return lines.join("");
}
