import React from "react";

const SEV = {
  critical: { color: "#f85149", bg: "rgba(248,81,73,0.12)", label: "CRIT" },
  high:     { color: "#e3650a", bg: "rgba(227,101,10,0.12)", label: "HIGH" },
  medium:   { color: "#d29922", bg: "rgba(210,153,34,0.12)", label: "MED" },
  low:      { color: "#388bfd", bg: "rgba(56,139,253,0.12)", label: "LOW" },
  info:     { color: "#8b949e", bg: "rgba(139,148,158,0.12)", label: "INFO" },
};

export default function SeverityBadge({ severity, full = false }) {
  const s = SEV[severity?.toLowerCase()] || SEV.info;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 7px",
      borderRadius: "3px",
      fontSize: "10px",
      fontWeight: 700,
      letterSpacing: "0.1em",
      color: s.color,
      background: s.bg,
      border: `1px solid ${s.color}33`,
      fontFamily: "var(--mono)",
      whiteSpace: "nowrap",
      userSelect: "none",
    }}>
      {full ? (severity?.toUpperCase() || "INFO") : s.label}
    </span>
  );
}
