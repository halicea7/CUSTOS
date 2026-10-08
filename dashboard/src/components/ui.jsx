import React, { createContext, useContext, useId, useState } from "react";

// Field gives its control an id and label/error wiring through context, so
// every input inside a Field is labelled for screen readers automatically.
const FieldCtx = createContext(null);
const useFieldProps = () => {
  const f = useContext(FieldCtx);
  if (!f) return {};
  return {
    id: f.id,
    "aria-invalid": f.error ? true : undefined,
    "aria-describedby": [f.hintId, f.error && f.errorId].filter(Boolean).join(" ") || undefined,
  };
};

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

export function PageWrap({ max = 1080, children }) {
  return <div style={{ padding: "28px 34px", maxWidth: max, margin: "0 auto" }}>{children}</div>;
}

export function TextInput({ theme, value, onChange, type = "text", placeholder, mono,
  autoFocus, onKeyDown, style, min, step, autoComplete }) {
  const [focus, setFocus] = useState(false);
  const field = useFieldProps();
  const invalid = !!field["aria-invalid"];
  return (
    <input type={type} value={value} placeholder={placeholder} autoFocus={autoFocus}
      onKeyDown={onKeyDown} onChange={onChange} min={min} step={step} autoComplete={autoComplete}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} {...field}
      style={{
        width: "100%", padding: "9px 12px", fontSize: 13, color: theme.c.text,
        fontFamily: mono ? theme.fontMono : theme.fontUi, background: theme.c.bg,
        border: `1px solid ${invalid ? theme.sev.critical.fg : focus ? theme.c.accent : theme.c.border}`,
        borderRadius: theme.radius, outline: "none", transition: "border-color 0.14s",
        boxShadow: focus ? `0 0 0 3px ${theme.c.accentBg}` : "none", ...style,
      }} />
  );
}

export function SelectInput({ theme, value, onChange, options }) {
  const field = useFieldProps();
  return (
    <select value={value} onChange={onChange} {...field} style={{
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
  const field = useFieldProps();
  return (
    <button type="button" role="switch" aria-checked={!!value} {...field}
      onClick={() => onChange(!value)} style={{ display: "flex", alignItems: "center",
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

export function Field({ theme, label, hint, error, children }) {
  const id = useId();
  const ctx = { id, hintId: hint ? `${id}-hint` : null, errorId: `${id}-error`, error };
  return (
    <FieldCtx.Provider value={ctx}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 6, lineHeight: 1.4 }}>
          <label htmlFor={id} style={{ fontSize: 11, fontWeight: 600, color: theme.c.text2,
            letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</label>
          {hint && <span id={ctx.hintId} style={{ marginLeft: 9, fontSize: 11.5, color: theme.c.text3 }}>{hint}</span>}
        </div>
        {children}
        {error && (
          <div id={ctx.errorId} role="alert" style={{ marginTop: 6, fontSize: 12, color: theme.sev.critical.fg }}>
            {error}
          </div>
        )}
      </div>
    </FieldCtx.Provider>
  );
}

// A native range input (keyboard + screen reader support for free) that moves
// between a fixed list of *steps*; *format* turns a step value into its label.
export function Slider({ theme, value, steps, onChange, format }) {
  const field = useFieldProps();
  const list = steps.includes(value) ? steps : [...steps, value].sort((a, b) => a - b);
  const index = list.indexOf(value);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <input type="range" min={0} max={list.length - 1} step={1} value={index}
        onChange={(e) => onChange(list[Number(e.target.value)])}
        aria-valuetext={format(value)} {...field}
        style={{ flex: 1, accentColor: theme.c.accent, cursor: "pointer" }} />
      <span style={{ minWidth: 112, textAlign: "right", fontFamily: theme.fontMono, fontSize: 12.5,
        color: theme.c.text }}>{format(value)}</span>
    </div>
  );
}

// Mutually exclusive options shown as cards; real radio inputs underneath.
export function ChoiceCards({ theme, name, value, onChange, options }) {
  const [focused, setFocused] = useState(null);
  return (
    <div role="radiogroup" style={{ display: "grid", gap: 10,
      gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label key={o.value} style={{
            display: "block", padding: "12px 14px", borderRadius: theme.radius, cursor: "pointer",
            border: `1px solid ${on ? theme.c.accent : theme.c.border}`,
            background: on ? theme.c.accentBg : theme.c.bg, transition: "all 0.14s",
            boxShadow: focused === o.value ? `0 0 0 3px ${theme.c.accentBg}` : "none",
            outline: focused === o.value ? `1px solid ${theme.c.accent}` : "none",
          }}>
            <input type="radio" name={name} value={o.value} checked={on}
              onChange={() => onChange(o.value)}
              onFocus={() => setFocused(o.value)} onBlur={() => setFocused(null)}
              style={{ position: "absolute", opacity: 0, width: 1, height: 1 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span aria-hidden style={{ width: 14, height: 14, borderRadius: 999, flexShrink: 0,
                border: `2px solid ${on ? theme.c.accent : theme.c.border2}`,
                background: on ? `radial-gradient(${theme.c.accent} 45%, transparent 50%)` : "transparent" }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.c.text }}>{o.label}</span>
            </div>
            {o.description && (
              <div style={{ marginTop: 5, marginLeft: 22, fontSize: 12, color: theme.c.text3, lineHeight: 1.45 }}>
                {o.description}
              </div>
            )}
          </label>
        );
      })}
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
