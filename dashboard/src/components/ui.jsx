import React, { createContext, useContext, useEffect, useId, useRef, useState } from "react";

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

export function PageHeader({ theme, title, subtitle, right }) { // eslint-disable-line no-unused-vars
  return (
    <div className="top">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="subt">{subtitle}</div>}
      </div>
      {right && <div className="tools">{right}</div>}
    </div>
  );
}

// Pages fill the window (fluid sizing in styles.css); *max* caps forms that
// would otherwise stretch uncomfortably wide.
export function PageWrap({ max, children }) {
  return <div className="page glow" style={max ? { maxWidth: max } : undefined}>{children}</div>;
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

export function Tabs({ theme, tabs, active, onChange }) { // eslint-disable-line no-unused-vars
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} className={active === t.key ? "on" : ""}
          onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export function SectionCard({ theme, title, subtitle, right, children, pad = true, tour }) { // eslint-disable-line no-unused-vars
  return (
    <section className="panel" style={{ marginBottom: "var(--gap)" }} data-tour={tour}>
      {title && (
        <div className="panel-h">
          <h2>{title}{subtitle && <span className="aside" style={{ fontWeight: 400 }}>{subtitle}</span>}</h2>
          {right}
        </div>
      )}
      <div className={pad ? "panel-b" : undefined}>{children}</div>
    </section>
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
            <input type="radio" name={name} value={o.value} checked={on} aria-label={o.label}
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

// eslint-disable-next-line no-unused-vars
export function Modal({ theme, title, subtitle, onClose, children, width = 480 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()} style={{ maxWidth: width }}>
        <div className="mh">
          <div>
            <div className="mt">{title}</div>
            {subtitle && <div className="muted" style={{ fontSize: ".84rem", marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button className="link" onClick={onClose} aria-label="Close" style={{ fontSize: "1.3rem", lineHeight: 1 }}>×</button>
        </div>
        <div className="mb">{children}</div>
      </div>
    </div>
  );
}

// Whether a model supports thinking/reasoning: true, false, or null (unknown).
export function ThinkBadge({ theme, value }) {
  const t = theme;
  const [text, color, title] = value === true
    ? ["think", t.c.accent, "Supports thinking / reasoning"]
    : value === false
      ? ["no think", t.c.text3, "Does not support thinking"]
      : ["?", t.c.text3, "The server doesn't report whether this model can think"];
  return (
    <span title={title} style={{ flexShrink: 0, padding: "1px 7px", borderRadius: 999, fontSize: 10.5,
      fontWeight: 600, letterSpacing: "0.02em", color, border: `1px solid ${color}55`,
      background: value === true ? t.c.accentBg : "transparent" }}>{text}</span>
  );
}

// Free-text model field with a dropdown of the server's models (ARIA combobox).
// *models*: [{ name, thinking: true|false|null, parameter_size? }] or null.
export function ModelPicker({ theme, value, onChange, models, placeholder }) {
  const t = theme;
  const field = useFieldProps();
  const listId = `${field.id || "model"}-listbox`;
  const wrap = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [focus, setFocus] = useState(false);
  const all = models || [];
  const options = query ? all.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())) : all;
  const invalid = !!field["aria-invalid"];

  const pick = (name) => { onChange(name); setOpen(false); setQuery(""); setActive(-1); };
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(0); return; }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (options.length ? (a + step + options.length) % options.length : -1));
    } else if (e.key === "Enter" && open && active >= 0 && options[active]) {
      e.preventDefault();
      pick(options[active].name);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={wrap} style={{ position: "relative" }}
      onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget)) setOpen(false); }}>
      <div style={{ display: "flex", alignItems: "stretch", borderRadius: theme.radius,
        border: `1px solid ${invalid ? t.sev.critical.fg : focus ? t.c.accent : t.c.border}`,
        boxShadow: focus ? `0 0 0 3px ${t.c.accentBg}` : "none", background: t.c.bg }}>
        <input {...field} role="combobox" aria-expanded={open} aria-controls={listId}
          aria-autocomplete="list" autoComplete="off"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          value={value || ""} placeholder={placeholder}
          onChange={(e) => { onChange(e.target.value); setQuery(e.target.value); setOpen(true); setActive(-1); }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocus(true)} onBlurCapture={() => setFocus(false)}
          style={{ flex: 1, minWidth: 0, padding: "9px 12px", fontSize: 13, color: t.c.text,
            fontFamily: t.fontMono, background: "transparent", border: "none", outline: "none" }} />
        <button type="button" tabIndex={-1} aria-label="Show available models"
          onClick={() => { setOpen((o) => !o); setQuery(""); setActive(-1); }}
          style={{ padding: "0 12px", background: "none", border: "none",
            borderLeft: `1px solid ${t.c.border}`, color: t.c.text2, cursor: "pointer", fontSize: 12 }}>
          {all.length ? `${all.length} ▾` : "▾"}
        </button>
      </div>
      {open && (
        <ul role="listbox" id={listId} style={{ position: "absolute", zIndex: 30, left: 0, right: 0,
          top: "calc(100% + 4px)", margin: 0, padding: 4, listStyle: "none", maxHeight: 280, overflowY: "auto",
          background: t.c.surface, border: `1px solid ${t.c.border2}`, borderRadius: theme.radius,
          boxShadow: t.c.shadowHi }}>
          {options.length === 0 && (
            <li style={{ padding: "8px 10px", fontSize: 12, color: t.c.text3 }}>
              {all.length ? "No matching models — the typed name will be used as-is"
                : "No model list yet — run the connection test, or type the name"}
            </li>
          )}
          {options.map((m, i) => (
            <li key={m.name} id={`${listId}-${i}`} role="option" aria-selected={m.name === value}
              onMouseDown={(e) => { e.preventDefault(); pick(m.name); }}
              onMouseEnter={() => setActive(i)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "pointer",
                borderRadius: theme.radius - 3,
                background: i === active ? t.c.raised2 : m.name === value ? t.c.accentBg : "transparent" }}>
              <span style={{ flex: 1, minWidth: 0, fontFamily: t.fontMono, fontSize: 12.5, color: t.c.text,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
              {m.parameter_size && <span style={{ fontSize: 11, color: t.c.text3 }}>{m.parameter_size}</span>}
              <ThinkBadge theme={t} value={m.thinking} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
