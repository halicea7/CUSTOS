import React from "react";
import { useTheme } from "../App.jsx";
import { STATUS_META } from "../theme.js";

export default function StatusBadge({ status }) {
  const { theme } = useTheme();
  const t = theme;
  const s = STATUS_META[status] || STATUS_META.pending;
  const color = t.mode === "light" ? s.light : s.dark;
  const animating = status === "analyzing";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 11, fontWeight: 500, color, fontFamily: t.fontUi, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0,
        animation: animating ? "custosPulse 1.3s ease-in-out infinite" : "none" }} />
      {s.label}
    </span>
  );
}
