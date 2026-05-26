import React from "react";

const ST = {
  pending:    { color: "#8b949e", bg: "rgba(139,148,158,0.10)", label: "PENDING" },
  analyzing:  { color: "#388bfd", bg: "rgba(56,139,253,0.10)",  label: "ANALYZING" },
  reviewed:   { color: "#d29922", bg: "rgba(210,153,34,0.10)",  label: "REVIEWED" },
  signed_off: { color: "#3fb950", bg: "rgba(63,185,80,0.10)",   label: "SIGNED OFF" },
  failed:     { color: "#f85149", bg: "rgba(248,81,73,0.10)",   label: "FAILED" },
};

export default function StatusBadge({ status }) {
  const s = ST[status?.toLowerCase()] || { color: "#8b949e", bg: "rgba(139,148,158,0.10)", label: status?.toUpperCase() || "—" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 8px",
      borderRadius: "3px",
      fontSize: "10px",
      fontWeight: 600,
      letterSpacing: "0.08em",
      color: s.color,
      background: s.bg,
      border: `1px solid ${s.color}33`,
      fontFamily: "var(--mono)",
      whiteSpace: "nowrap",
      userSelect: "none",
    }}>
      {status === "analyzing" && (
        <span style={{
          display: "inline-block", width: "6px", height: "6px",
          borderRadius: "50%", background: s.color,
          marginRight: "5px",
          animation: "pulse 1.4s ease-in-out infinite",
        }} />
      )}
      {s.label}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </span>
  );
}
