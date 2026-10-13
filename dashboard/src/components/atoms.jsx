import React from "react";
import { SEV_ORDER, STATUS_META } from "../theme.js";

export { SEV_ORDER };

export function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Severity({ theme, severity, count, size = "sm" }) {
  const meta = theme.sev[severity] || theme.sev.info;
  const label = size === "lg" ? meta.label : meta.short;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: size === "lg" ? "3px 11px" : "2px 9px",
      borderRadius: 999, fontSize: size === "lg" ? 12 : 11, fontWeight: 600,
      color: meta.fg, background: meta.bg, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: meta.solid, flexShrink: 0 }} />
      {count != null ? `${count} ` : ""}{label}
    </span>
  );
}

export function SeverityBar({ theme, counts, height = 6 }) {
  const total = SEV_ORDER.reduce((a, k) => a + (counts[k] || 0), 0);
  if (total === 0) return (
    <div style={{ height, borderRadius: 999, background: theme.c.border, width: "100%" }} />
  );
  return (
    <div style={{ display: "flex", height, width: "100%", borderRadius: 999, overflow: "hidden",
      background: theme.c.border, gap: 1.5 }}>
      {SEV_ORDER.map((k) => {
        const n = counts[k] || 0;
        if (!n) return null;
        return <div key={k} title={`${n} ${k}`} style={{ flex: n, background: theme.sev[k].solid, minWidth: 3 }} />;
      })}
    </div>
  );
}

export function StatusBadge({ theme, status, size = "sm" }) {
  const s = STATUS_META[status] || STATUS_META.pending;
  const color = theme.mode === "light" ? s.light : s.dark;
  const animating = status === "analyzing";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: size === "lg" ? 12 : 11, fontWeight: 500,
      color, fontFamily: theme.fontUi, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0,
        animation: animating ? "custosPulse 1.3s ease-in-out infinite" : "none" }} />
      {s.label}
    </span>
  );
}

export function DispositionTag({ theme, disposition, size = "sm" }) {
  if (!disposition) return null;
  const map = {
    confirmed:      { label: "Confirmed",      color: theme.sev.critical.fg },
    false_positive: { label: "False positive",  color: theme.status.signed_off[theme.mode === "light" ? "light" : "dark"] },
    escalated:      { label: "Escalated",       color: theme.c.accent },
  };
  const d = map[disposition];
  if (!d) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: size === "lg" ? "3px 10px" : "2px 8px",
      borderRadius: 999, fontSize: size === "lg" ? 11 : 10, fontWeight: 600,
      color: d.color, background: `${d.color}1c`, border: `1px solid ${d.color}33`,
      whiteSpace: "nowrap",
    }}>{d.label}</span>
  );
}

// Styling lives in styles.css (.btn); *theme* is accepted for older call sites.
// eslint-disable-next-line no-unused-vars
export function Btn({ theme, children, variant = "ghost", onClick, active, style, full, size = "md",
  disabled, title, type = "button", className = "" }) {
  const cls = ["btn", variant !== "ghost" && variant, size !== "md" && size, full && "full",
    active && "active", className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} title={title} style={style}>
      {children}
    </button>
  );
}

export function Pill({ theme, children, tone }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px",
      borderRadius: 999, fontSize: 11, fontFamily: theme.fontMono,
      color: tone || theme.c.text2, background: theme.c.raised,
      border: `1px solid ${theme.c.border}`, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

export function Label({ theme, children, style }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
      textTransform: "uppercase", color: theme.c.text3, whiteSpace: "nowrap",
      fontFamily: theme.fontUi, ...style,
    }}>{children}</div>
  );
}

export function Avatar({ theme, name, size = 30 }) {
  const initials = (name || "?")
    .split(/[.\-_ ]/).filter(Boolean).slice(0, 2)
    .map((s) => s[0].toUpperCase()).join("");
  return (
    <div style={{
      width: size, height: size, borderRadius: 999,
      background: theme.c.accentBg, color: theme.c.accent,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.4, fontWeight: 700, fontFamily: theme.fontDisplay, flexShrink: 0,
    }}>{initials}</div>
  );
}

export function RoleBadge({ theme, role, onClick, clickable }) {
  const isAdmin = role === "admin";
  const color = isAdmin
    ? theme.c.accent
    : theme.status.analyzing[theme.mode === "light" ? "light" : "dark"];
  return (
    <span onClick={onClick} title={clickable ? "Click to change role" : undefined}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
        color, background: `${color}1a`, border: `1px solid ${color}33`,
        cursor: clickable ? "pointer" : "default", userSelect: "none", textTransform: "capitalize",
      }}>
      {role}{clickable && <span style={{ opacity: 0.6, fontSize: 10 }}>⇅</span>}
    </span>
  );
}
