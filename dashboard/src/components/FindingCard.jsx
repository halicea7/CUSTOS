import React from "react";
import { Link } from "react-router-dom";
import SeverityBadge from "./SeverityBadge.jsx";

const DISP_COLORS = {
  confirmed: { color: "#f85149", label: "CONFIRMED" },
  false_positive: { color: "#3fb950", label: "FALSE POS" },
  escalated: { color: "#bc8cff", label: "ESCALATED" },
};

export default function FindingCard({ finding }) {
  const disp = finding.disposition ? DISP_COLORS[finding.disposition] : null;

  return (
    <Link
      to={`/findings/${finding.id}`}
      style={{ textDecoration: "none", display: "block" }}
    >
      <div style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "start",
        gap: "12px",
        padding: "10px 14px",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border)",
        background: "var(--bg-3)",
        cursor: "pointer",
        transition: "border-color 0.15s, background 0.15s",
      }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-2)"; e.currentTarget.style.background = "var(--bg-4)"; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-3)"; }}
      >
        <SeverityBadge severity={finding.severity} />
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--text)", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {finding.title}
          </div>
          <div style={{ display: "flex", gap: "10px", marginTop: "3px", flexWrap: "wrap" }}>
            {finding.file_path && (
              <span style={{ color: "var(--text-3)", fontSize: "11px" }}>
                {finding.file_path}{finding.line_start ? `:${finding.line_start}` : ""}
              </span>
            )}
            {finding.source && (
              <span style={{ color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.05em", textTransform: "uppercase" }}>
                [{finding.source}]
              </span>
            )}
            {finding.cwe && (
              <span style={{ color: "var(--text-3)", fontSize: "11px" }}>{finding.cwe}</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {disp ? (
            <span style={{
              fontSize: "10px", fontWeight: 600, letterSpacing: "0.08em",
              color: disp.color, padding: "1px 6px",
              border: `1px solid ${disp.color}33`,
              borderRadius: "3px",
              background: `${disp.color}11`,
            }}>
              {disp.label}
            </span>
          ) : (
            <span style={{ color: "var(--text-3)", fontSize: "11px" }}>—</span>
          )}
          <span style={{ color: "var(--text-3)", fontSize: "14px" }}>›</span>
        </div>
      </div>
    </Link>
  );
}
