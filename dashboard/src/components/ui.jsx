import React, { useState } from "react";

export function PageHeader({ theme, title, subtitle, right }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between",
      gap: 20, marginBottom: 24, flexWrap: "wrap" }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: theme.c.text,
          fontFamily: theme.fontDisplay, letterSpacing: "-0.025em" }}>{title}</h1>
        {subtitle && <div style={{ fontSize: 13, color: theme.c.text3, marginTop: 5 }}>{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

export function PageWrap({ theme, max = 1080, children }) {
  return <div style={{ padding: "28px 34px", maxWidth: max, margin: "0 auto" }}>{children}</div>;
}

export function TextInput({ theme, value, onChange, type = "text", placeholder, mono,
  autoFocus, onKeyDown, style, min, step }) {
  const [focus, setFocus] = useState(false);
  return (
    <input type={type} value={value} placeholder={placeholder} autoFocus={autoFocus}
      onKeyDown={onKeyDown} onChange={onChange} min={min} step={step}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      style={{
        width: "100%", padding: "9px 12px", fontSize: 13, color: theme.c.text,
        fontFamily: mono ? theme.fontMono : theme.fontUi, background: theme.c.bg,
        border: `1px solid ${focus ? theme.c.accent : theme.c.border}`,
        borderRadius: theme.radius, outline: "none", transition: "border-color 0.14s",
        boxShadow: focus ? `0 0 0 3px ${theme.c.accentBg}` : "none", ...style,
      }} />
  );
}

export function SelectInput({ theme, value, onChange, options }) {
  return (
    <select value={value} onChange={onChange} style={{
      width: "100%", padding: "9px 12px", fontSize: 13,
      color: theme.c.text, fontFamily: theme.fontUi, background: theme.c.bg,
      border: `1px solid ${theme.c.border}`, borderRadius: theme.radius,
      outline: "none", cursor: "pointer",
    }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Toggle({ theme, value, onChange, label }) {
  return (
    <button onClick={() => onChange(!value)} style={{ display: "flex", alignItems: "center",
      gap: 10, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
      <span style={{ width: 38, height: 22, borderRadius: 999,
        background: value ? theme.c.accent : theme.c.border2,
        position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
        <span style={{ position: "absolute", top: 3, left: value ? 19 : 3, width: 16, height: 16,
          borderRadius: "50%", background: "#fff", transition: "left 0.2s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.3)" }} />
      </span>
      {label && <span style={{ fontSize: 13, color: theme.c.text2 }}>{label}</span>}
    </button>
  );
}

export function Tabs({ theme, tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 26,
      borderBottom: `1px solid ${theme.c.border}` }}>
      {tabs.map((t) => {
        const on = active === t.key;
        return (
          <button key={t.key} onClick={() => onChange(t.key)} style={{
            padding: "9px 16px", background: "none", border: "none",
            borderBottom: `2px solid ${on ? theme.c.accent : "transparent"}`,
            marginBottom: -1, color: on ? theme.c.accent : theme.c.text2,
            fontSize: 13, fontWeight: on ? 600 : 500, cursor: "pointer",
            fontFamily: theme.fontUi, transition: "color 0.14s",
          }}>{t.label}</button>
        );
      })}
    </div>
  );
}

export function SectionCard({ theme, title, subtitle, right, children, pad = true }) {
  return (
    <div style={{ border: `1px solid ${theme.c.border}`, borderRadius: theme.radiusLg,
      overflow: "hidden", marginBottom: 18, background: theme.c.surface,
      boxShadow: theme.c.shadow }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, padding: "13px 18px", borderBottom: `1px solid ${theme.c.border}`,
          background: theme.c.raised }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.c.text,
              fontFamily: theme.fontDisplay }}>{title}</span>
            {subtitle && <span style={{ fontSize: 12, color: theme.c.text3 }}>{subtitle}</span>}
          </div>
          {right}
        </div>
      )}
      <div style={{ padding: pad ? "18px" : 0 }}>{children}</div>
    </div>
  );
}

export function Field({ theme, label, hint, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 6, lineHeight: 1.4 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: theme.c.text2,
          letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</label>
        {hint && <span style={{ marginLeft: 9, fontSize: 11.5, color: theme.c.text3 }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Feedback({ theme, msg, type }) {
  if (!msg) return null;
  const ok = type === "success";
  const color = ok
    ? theme.status.signed_off[theme.mode === "light" ? "light" : "dark"]
    : theme.sev.critical.fg;
  return (
    <div style={{ marginTop: 12, padding: "9px 13px", borderRadius: theme.radius,
      fontSize: 12.5, color, background: `${color}1a`,
      border: `1px solid ${color}33` }}>{msg}</div>
  );
}

export function Modal({ theme, title, subtitle, onClose, children, width = 480 }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(8,10,16,0.55)", backdropFilter: "blur(3px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: width, background: theme.c.surface,
        border: `1px solid ${theme.c.border}`, borderRadius: theme.radiusLg,
        boxShadow: theme.c.shadowHi, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          gap: 12, padding: "18px 20px", borderBottom: `1px solid ${theme.c.border}` }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: theme.c.text,
              fontFamily: theme.fontDisplay }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12.5, color: theme.c.text3, marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none",
            color: theme.c.text3, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
