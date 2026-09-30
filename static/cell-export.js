import { renderMarkdown } from "./notebook-core.mjs";
import { renderNotebookHTML } from "./notebook-export.mjs";
import { renderMermaidDiagrams } from "./mermaid-renderer.js";
import "./vendor/html-to-image.js";
const content = document.querySelector("#content");
const status = document.querySelector("#status");
const png = document.querySelector("#png");
const pdf = document.querySelector("#pdf");
let filename = "单元格";
async function downloadImage() {
  png.disabled = true;
  status.textContent = "正在生成图片…";
  try {
    await document.fonts.ready;
    if (content.scrollHeight > 15000)
      throw new Error("内容过长，请使用 PDF 导出以自动分页。");
    const blob = await globalThis.htmlToImage.toBlob(content, {
      pixelRatio: 2,
      style: { margin: "0" },
      backgroundColor: "#ffffff",
      skipFonts: true,
    });
    if (!blob) throw new Error("图片生成失败，请重试。");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename + ".png";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = "PNG 已生成。";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    png.disabled = false;
  }
}
try {
  const key = location.hash.slice(1);
  if (!/^cell-export-[a-f0-9-]+$/.test(key))
    throw new Error("导出链接无效，请从单元格重新导出。");
  const raw = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (window.opener) {
    window.opener.sessionStorage.removeItem(key);
    window.opener = null;
  }
  history.replaceState(null, "", location.pathname);
  if (!raw) throw new Error("导出内容已过期，请从单元格重新导出。");
  const { cell, notebook, attachments, relatedTitle, title, mode } =
    JSON.parse(raw);
  filename =
    (notebook?.title || title || "笔记")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .slice(0, 100) + (notebook ? "-整页" : "-单元格");
  document.title = filename;
  if (notebook) {
    document.querySelector("header strong").textContent = "整页 PDF 导出";
    png.hidden = true;
    content.innerHTML = renderNotebookHTML(notebook, attachments, relatedTitle);
    await renderMermaidDiagrams(content);
    await Promise.all(
      [...content.querySelectorAll("img")].map((image) =>
        image.decode().catch(() => {}),
      ),
    );
  } else if (cell?.type === "markdown") {
    content.innerHTML = renderMarkdown(cell.source);
    await renderMermaidDiagrams(content);
  } else if (cell) {
    const pre = document.createElement("pre");
    pre.textContent = cell.source;
    content.append(pre);
  } else throw new Error("导出内容无效，请从笔记重新导出。");
  png.addEventListener("click", downloadImage);
  pdf.addEventListener("click", () => window.print());
  await document.fonts.ready;
  status.textContent = notebook
    ? "已准备完整笔记。请在打印窗口中选择“另存为 PDF”。"
    : "仅导出当前单元格正文。PDF 请在打印窗口中选择“另存为 PDF”。";
  if (mode === "image") await downloadImage();
  else window.print();
} catch (error) {
  status.textContent = error.message;
  png.disabled = pdf.disabled = true;
}
