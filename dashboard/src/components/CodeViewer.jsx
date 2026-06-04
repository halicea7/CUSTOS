import React, { useEffect, useRef, useState } from "react";
import hljs from "highlight.js";
import { useTheme } from "../App.jsx";

// Dark hljs theme
const HLJS_DARK = `
.hljs{color:#c9d1d9;background:transparent}
.hljs-comment,.hljs-meta{color:#8b949e;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-name,.hljs-tag{color:#ff7b72}
.hljs-string,.hljs-attr,.hljs-symbol,.hljs-bullet,.hljs-addition{color:#a5d6ff}
.hljs-title,.hljs-section,.hljs-attribute{color:#d2a8ff}
.hljs-variable,.hljs-template-variable{color:#ffa657}
.hljs-literal,.hljs-type,.hljs-params{color:#79c0ff}
.hljs-number{color:#7c79f2}
.hljs-deletion{color:#f85149}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
`;

// Light hljs theme
const HLJS_LIGHT = `
.hljs{color:#24292e;background:transparent}
.hljs-comment,.hljs-meta{color:#6a737d;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-name,.hljs-tag{color:#d73a49}
.hljs-string,.hljs-attr,.hljs-symbol,.hljs-bullet,.hljs-addition{color:#032f62}
.hljs-title,.hljs-section,.hljs-attribute{color:#6f42c1}
.hljs-variable,.hljs-template-variable{color:#e36209}
.hljs-literal,.hljs-type,.hljs-params{color:#005cc5}
.hljs-number{color:#4f46e5}
.hljs-deletion{color:#b31d28}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
`;

export default function CodeViewer({ code, language, lineStart, lineEnd, filePath }) {
  const { theme } = useTheme();
  const t = theme;
  const preRef = useRef(null);
  const [highlighted, setHighlighted] = useState("");

  useEffect(() => {
    if (!code) return;
    let result;
    try {
      if (language) {
        const lang = hljs.getLanguage(language) ? language : "plaintext";
        result = hljs.highlight(code, { language: lang });
      } else {
        result = hljs.highlightAuto(code);
      }
      setHighlighted(result.value);
    } catch {
      setHighlighted(code.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
  }, [code, language]);

  if (!code) return null;

  const lines = (highlighted || code).split("\n");
  const startNum = typeof lineStart === "number" ? lineStart : 1;

  const isLight = t.mode === "light";
  const codeBg  = isLight ? "#f8f9fb" : "#0c0e13";
  const gutterBg = isLight ? "#f3f4f7" : "#0d1014";

  return (
    <div style={{ borderRadius: t.radius, overflow: "hidden",
      border: `1px solid ${t.c.border}`, background: codeBg }}>
      <style>{isLight ? HLJS_LIGHT : HLJS_DARK}</style>
      {filePath && (
        <div style={{ padding: "7px 14px", borderBottom: `1px solid ${t.c.border}`,
          background: t.c.raised, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: t.c.text3, fontSize: 11, fontFamily: t.fontMono }}>
            {filePath}
            {lineStart && (
              <span style={{ color: t.c.text3 }}>
                :{lineStart}{lineEnd && lineEnd !== lineStart ? `–${lineEnd}` : ""}
              </span>
            )}
          </span>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%",
          fontFamily: t.fontMono, fontSize: 12, lineHeight: "1.6" }}>
          <tbody>
            {lines.map((line, i) => {
              const lineNum = startNum + i;
              const isHighlighted = lineStart && lineEnd
                ? lineNum >= lineStart && lineNum <= lineEnd
                : lineStart ? lineNum === lineStart : false;
              const hlBg  = isHighlighted ? (isLight ? "rgba(220,38,38,0.06)" : "rgba(248,81,73,0.1)") : "transparent";
              const hlBorder = isHighlighted ? (isLight ? "#dc2626" : "#f85149") : "transparent";
              return (
                <tr key={i} style={{ background: hlBg,
                  borderLeft: `2px solid ${hlBorder}` }}>
                  <td style={{ padding: "0 12px 0 10px", color: isHighlighted ? t.c.accent : t.c.text3,
                    textAlign: "right", userSelect: "none", minWidth: 42, fontSize: 11,
                    background: gutterBg, borderRight: `1px solid ${t.c.border}`,
                    fontVariantNumeric: "tabular-nums" }}>
                    {lineNum}
                  </td>
                  <td style={{ padding: "0 20px 0 14px", whiteSpace: "pre",
                    color: isHighlighted ? t.c.text : undefined }}
                    dangerouslySetInnerHTML={{ __html: line || "&nbsp;" }}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
