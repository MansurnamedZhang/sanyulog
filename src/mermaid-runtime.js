import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: {
    fontFamily: '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    fontSize: "14px",
    primaryColor: "#f4f8ee",
    primaryBorderColor: "#91aa83",
    primaryTextColor: "#334a3b",
    lineColor: "#6b806d",
    secondaryColor: "#f8faf5",
    tertiaryColor: "#ffffff",
    background: "#ffffff",
  },
  maxTextSize: 50000,
  flowchart: { htmlLabels: false },
});

export const renderDiagram = (id, source) => mermaid.render(id, source);
