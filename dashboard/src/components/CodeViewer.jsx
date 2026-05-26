import React, { useEffect, useRef, useState } from "react";
import hljs from "highlight.js";

// Minimal dark theme inlined to avoid CSS import issues
const THEME = `
.hljs{color:#c9d1d9;background:transparent}
.hljs-comment,.hljs-meta{color:#8b949e;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-name,.hljs-tag{color:#ff7b72}
.hljs-string,.hljs-attr,.hljs-symbol,.hljs-bullet,.hljs-addition{color:#a5d6ff}
.hljs-title,.hljs-section,.hljs-attribute{color:#d2a8ff}
.hljs-variable,.hljs-template-variable{color:#ffa657}
.hljs-literal,.hljs-type,.hljs-params{color:#79c0ff}
.hljs-number{color:#f0a500}
.hljs-deletion{color:#f85149}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
`;

export default function CodeViewer({ code, language, lineStart, lineEnd, filePath }) {
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

  return (
    <div style={{
      borderRadius: "var(--radius-lg)",
      border: "1px solid var(--border)",
      overflow: "hidden",
      background: "#0d1117",
    }}>
      <style>{THEME}</style>
      {filePath && (
        <div style={{
          padding: "7px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-3)",
          display: "flex", alignItems: "center", gap: "8px",
        }}>
          <span style={{ color: "var(--text-3)", fontSize: "11px" }}>📄</span>
          <span style={{ color: "var(--text-2)", fontSize: "11px", fontFamily: "var(--mono)" }}>
            {filePath}
            {lineStart && <span style={{ color: "var(--text-3)" }}>:{lineStart}{lineEnd && lineEnd !== lineStart ? `–${lineEnd}` : ""}</span>}
          </span>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{
          borderCollapse: "collapse", width: "100%",
          fontFamily: "var(--mono)", fontSize: "12px", lineHeight: "1.6",
        }}>
          <tbody>
            {lines.map((line, i) => {
              const lineNum = startNum + i;
              const isHighlighted = lineStart && lineEnd
                ? lineNum >= lineStart && lineNum <= lineEnd
                : lineStart
                ? lineNum === lineStart
                : false;
              return (
                <tr key={i} style={{
                  background: isHighlighted ? "rgba(240,165,0,0.08)" : "transparent",
                  borderLeft: isHighlighted ? "2px solid var(--accent)" : "2px solid transparent",
                }}>
                  <td style={{
                    padding: "0 14px 0 10px",
                    color: isHighlighted ? "var(--accent)" : "var(--text-3)",
                    textAlign: "right",
                    userSelect: "none",
                    minWidth: "42px",
                    fontSize: "11px",
                    opacity: isHighlighted ? 1 : 0.6,
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {lineNum}
                  </td>
                  <td style={{
                    padding: "0 20px 0 0",
                    whiteSpace: "pre",
                    color: isHighlighted ? "#ffd787" : undefined,
                  }}
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
