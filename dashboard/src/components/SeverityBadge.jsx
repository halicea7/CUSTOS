import React from "react";
import { useTheme } from "../App.jsx";

export default function SeverityBadge({ severity, full = false }) {
  const { theme } = useTheme();
  const t = theme;
  const meta = t.sev[severity?.toLowerCase()] || t.sev.info;
  const label = full ? meta.label : meta.short;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "2px 9px", borderRadius: 999,
      fontSize: 11, fontWeight: 600,
      color: meta.fg, background: meta.bg, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: meta.solid, flexShrink: 0 }} />
      {label}
    </span>
  );
}
