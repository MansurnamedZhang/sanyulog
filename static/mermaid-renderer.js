let runtime;
let nextId = 0;
const MAX_SOURCE_LENGTH = 50000;

function getRuntime() {
  runtime ||= import("./vendor/mermaid-runtime.js");
  return runtime;
}

export async function renderMermaid(container, source) {
  if (!container?.isConnected) return;
  const revision = Symbol("mermaid-render");
  container.mermaidRevision = revision;
  const pre = container.querySelector(".nb-mermaid-source");
  let output = container.querySelector(".nb-mermaid-output");
  if (!output) {
    output = document.createElement("div");
    output.className = "nb-mermaid-output";
    container.append(output);
  }
  const showError = (message) => {
    if (container.mermaidRevision !== revision || !container.isConnected)
      return;
    output.textContent = message;
    if (pre) pre.hidden = false;
    container.classList.add("nb-mermaid-invalid");
  };
  output.textContent = "正在绘制流程图…";
  container.classList.remove("nb-mermaid-invalid");
  if (pre) pre.hidden = false;
  if (!source.trim() || source.length > MAX_SOURCE_LENGTH) {
    showError("流程图为空或超过 50,000 字符，请修改源码。");
    return;
  }
  try {
    const { renderDiagram } = await getRuntime();
    const { svg } = await renderDiagram(`nb-mermaid-${++nextId}`, source);
    if (container.mermaidRevision !== revision || !container.isConnected)
      return;
    // An SVG used as an image applies its own styles under the current CSP and
    // cannot run diagram-authored scripts in the page.
    const image = document.createElement("img");
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    image.alt = "Mermaid 流程图：" + source.slice(0, 1000);
    const width = Number(
      svg.match(/viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)/)?.[1],
    );
    if (width > 0) image.width = Math.min(2400, Math.ceil(width));
    await image.decode();
    if (container.mermaidRevision !== revision || !container.isConnected)
      return;
    output.replaceChildren(image);
    if (pre) pre.hidden = true;
  } catch (error) {
    showError(
      "流程图语法有误，请修改源码：" +
        String(error.message || error).slice(0, 300),
    );
  }
}

export function renderMermaidDiagrams(root) {
  return Promise.all(
    [...root.querySelectorAll(".nb-mermaid")].map((container) =>
      renderMermaid(
        container,
        container.querySelector(".nb-mermaid-source")?.textContent || "",
      ),
    ),
  );
}
