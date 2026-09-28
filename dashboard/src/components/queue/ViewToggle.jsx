import React from "react";

const GridIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" />
  </svg>
);

const ListIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" />
    <circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);

export default function ViewToggle({ theme, view, setView }) {
  return (
    <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 999,
      background: theme.c.raised2, border: `1px solid ${theme.c.border}` }}>
      {[{ k: "grid", icon: "grid" }, { k: "list", icon: "list" }].map((o) => {
        const on = view === o.k;
        return (
          <button key={o.k} onClick={() => setView(o.k)} title={`${o.k} view`} style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "5px 9px", borderRadius: 999, cursor: "pointer", border: "none",
            background: on ? theme.c.surface : "transparent",
            color: on ? theme.c.accent : theme.c.text3,
            boxShadow: on ? theme.c.shadow : "none", transition: "all 0.14s",
          }}>
            {o.k === "grid" ? <GridIcon /> : <ListIcon />}
          </button>
        );
      })}
    </div>
  );
}
