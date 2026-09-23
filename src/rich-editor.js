import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import Image from "@tiptap/extension-image";

// Keep the previously supported \(...\) and \[...\] notation readable too.
const InlineFormula = InlineMath.extend({
  markdownTokenizer: {
    name: "inlineMath",
    level: "inline",
    start: (src) => {
      const match = /\$|\\\(/.exec(src);
      return match?.index;
    },
    tokenize: (src) => {
      const match =
        /^\$(?!\$)([^\n$]+?)\$(?!\$)/.exec(src) || /^\\\((.+?)\\\)/.exec(src);
      return match
        ? { type: "inlineMath", raw: match[0], latex: match[1] }
        : undefined;
    },
  },
});
const BlockFormula = BlockMath.extend({
  markdownTokenizer: {
    name: "blockMath",
    level: "block",
    start: (src) => {
      const match = /\$\$|\\\[/.exec(src);
      return match?.index;
    },
    tokenize: (src) => {
      const match =
        /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
      return match
        ? { type: "blockMath", raw: match[0], latex: match[1].trim() }
        : undefined;
    },
  },
});

const DiagramCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const isDiagram = node.attrs.language?.toLowerCase() === "mermaid";
      if (!isDiagram) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.className = node.attrs.language
          ? `language-${node.attrs.language}`
          : "";
        pre.append(code);
        return {
          dom: pre,
          contentDOM: code,
          update(nextNode) {
            if (
              nextNode.type !== node.type ||
              nextNode.attrs.language?.toLowerCase() === "mermaid"
            )
              return false;
            code.className = nextNode.attrs.language
              ? `language-${nextNode.attrs.language}`
              : "";
            return true;
          },
        };
      }
      let currentNode = node;
      let timer;
      let dialog;
      const dom = document.createElement("div");
      dom.className = "nb-mermaid nb-mermaid-editor";
      const controls = document.createElement("div");
      controls.className = "nb-mermaid-controls";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button small";
      button.dataset.nb = "mermaid-edit";
      button.textContent = "编辑流程图";
      controls.append(button);
      const pre = document.createElement("pre");
      pre.className = "nb-mermaid-source";
      dom.append(controls, pre);
      const schedule = (text) => {
        pre.textContent = text;
        clearTimeout(timer);
        dom.mermaidRevision = Symbol("mermaid-edit");
        timer = setTimeout(() => this.options.renderDiagram(dom, text), 300);
      };
      button.onclick = () => {
        dialog = document.createElement("dialog");
        dialog.className = "nb-mermaid-dialog nb-formula-dialog";
        dialog.innerHTML =
          '<form><h3>编辑 Mermaid 流程图</h3><label>图定义<textarea aria-label="Mermaid 图定义" required></textarea></label><div><button type="submit" class="button">应用</button><button type="button" class="button subtle">取消</button></div></form>';
        const input = dialog.querySelector("textarea");
        input.value = currentNode.textContent;
        dialog.querySelector("form").onsubmit = (event) => {
          event.preventDefault();
          const pos = getPos();
          const original =
            typeof pos === "number" && editor.state.doc.nodeAt(pos);
          if (original?.type.name === "codeBlock")
            editor.commands.insertContentAt(
              { from: pos, to: pos + original.nodeSize },
              {
                type: "codeBlock",
                attrs: { ...original.attrs, language: "mermaid" },
                content: [{ type: "text", text: input.value }],
              },
            );
          dialog.close();
        };
        dialog.querySelector('[type="button"]').onclick = () => dialog.close();
        dialog.addEventListener("close", () => dialog.remove());
        document.body.append(dialog);
        dialog.showModal();
        input.focus();
      };
      schedule(node.textContent);
      return {
        dom,
        update(nextNode) {
          if (
            nextNode.type !== node.type ||
            nextNode.attrs.language?.toLowerCase() !== "mermaid"
          )
            return false;
          currentNode = nextNode;
          schedule(nextNode.textContent);
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: () => true,
        destroy() {
          clearTimeout(timer);
          dom.mermaidRevision = Symbol("mermaid-destroy");
          dialog?.remove();
        },
      };
    };
  },
});

export function createRichEditor(element, source, onChange, renderDiagram) {
  let editor;
  const editFormula = (block, node, pos) => {
    const dialog = document.createElement("dialog");
    dialog.className = "nb-formula-dialog";
    dialog.innerHTML =
      '<form><h3>LaTeX 公式</h3><label>公式内容<textarea aria-label="LaTeX 公式内容" required></textarea></label><div><button type="submit" class="button">应用</button><button type="button" class="button subtle">取消</button></div></form>';
    const input = dialog.querySelector("textarea");
    input.value = node?.attrs.latex || "x^2";
    dialog.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      const latex = input.value;
      const command = node
        ? block
          ? "updateBlockMath"
          : "updateInlineMath"
        : block
          ? "insertBlockMath"
          : "insertInlineMath";
      if (!editor.isDestroyed)
        editor
          .chain()
          .focus()
          [command]({ latex, ...(node ? { pos } : {}) })
          .run();
      dialog.close();
    };
    dialog.querySelector('[type="button"]').onclick = () => dialog.close();
    dialog.addEventListener("close", () => dialog.remove());
    element.append(dialog);
    dialog.showModal();
    input.focus();
  };
  editor = new Editor({
    element,
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: false },
        codeBlock: false,
      }),
      DiagramCodeBlock.configure({ renderDiagram }),
      Markdown,
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ allowBase64: false }),
      InlineFormula.configure({
        katexOptions: { output: "mathml", throwOnError: false, trust: false },
        onClick: (node, pos) => editFormula(false, node, pos),
      }),
      BlockFormula.configure({
        katexOptions: { output: "mathml", throwOnError: false, trust: false },
        onClick: (node, pos) => editFormula(true, node, pos),
      }),
    ],
    content: source,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "nb-markdown nb-rich-content",
        "aria-label": "所见即所得内容",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleClick(view, pos, event) {
        if (
          event.button !== 0 ||
          event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          !event.target.closest("td, th")
        )
          return false;
        // Commit a cell click synchronously. Native selectionchange can arrive
        // after the next keydown and otherwise leave the previous cell active.
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.near(view.state.doc.resolve(pos)))
            .setMeta("pointer", true),
        );
        return true;
      },
      handlePaste(view, event) {
        if (event.clipboardData?.files.length) return false;
        // Plain paragraphs inside a table belong to this cell, not adjacent cells.
        const inCell = Array.from(
          { length: view.state.selection.$from.depth },
          (_, i) => view.state.selection.$from.node(i + 1).type.name,
        ).some((name) => name === "tableCell" || name === "tableHeader");
        const text = event.clipboardData?.getData("text/plain") || "";
        const html = event.clipboardData?.getData("text/html") || "";
        if (
          inCell &&
          text &&
          !text.includes("\t") &&
          !/<table(?:\s|>)/i.test(html)
        ) {
          const content = [];
          text
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .forEach((line, i) => {
              if (i) content.push({ type: "hardBreak" });
              if (line) content.push({ type: "text", text: line });
            });
          editor.commands.insertContent(content);
          return true;
        }
        return false;
      },
    },
    onSelectionUpdate: () => {
      const tools = element.nextElementSibling;
      if (tools?.classList.contains("nb-rich-table-tools"))
        tools.hidden = !editor.isActive("table");
    },
    onUpdate: () => onChange(editor.getMarkdown()),
  });
  return {
    editor,
    destroy: () => editor.destroy(),
    focus: () => editor.commands.focus(),
    command(tool, options = {}) {
      if (tool === "math" || tool === "mathblock") {
        editFormula(tool === "mathblock");
        return;
      }
      if (tool === "mermaid") {
        const { from, to } = editor.state.selection;
        const selected = editor.state.doc.textBetween(from, to, "\n").trim();
        const text = selected || "flowchart TD\nA[开始] --> B[结束]";
        return editor
          .chain()
          .focus()
          .insertContentAt(
            { from, to },
            {
              type: "codeBlock",
              attrs: { language: "mermaid" },
              content: [{ type: "text", text }],
            },
          )
          .run();
      }
      // Synchronous focus prevents a deferred toolbar focus from stealing the
      // caret after the user has already clicked another table cell.
      editor.view.focus();
      const chain = editor.chain();
      const actions = {
        bold: () => chain.toggleBold(),
        italic: () => chain.toggleItalic(),
        heading: () => chain.toggleHeading({ level: 2 }),
        unordered: () => chain.toggleBulletList(),
        ordered: () => chain.toggleOrderedList(),
        indent: () => chain.sinkListItem("listItem"),
        outdent: () => chain.liftListItem("listItem"),
        code: () => chain.toggleCode(),
        codeblock: () => chain.toggleCodeBlock(),
        table: () =>
          chain.insertTable({
            rows: options.rows || 3,
            cols: options.cols || 3,
            withHeaderRow: true,
          }),
        row: () => chain.addRowAfter(),
        column: () => chain.addColumnAfter(),
        "delete-row": () => chain.deleteRow(),
        "delete-column": () => chain.deleteColumn(),
        undo: () => chain.undo(),
        redo: () => chain.redo(),
      };
      return actions[tool]?.().run();
    },
  };
}
