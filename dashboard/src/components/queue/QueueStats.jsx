import React from "react";
import { SeverityBar, SEV_ORDER } from "../atoms.jsx";

export default function QueueStats({ theme, submissions }) {
  const totals = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let openCount = 0, analyzing = 0;
  submissions.forEach((s) => {
    SEV_ORDER.forEach((k) => (totals[k] += (s.finding_counts?.[k] || 0)));
    if (s.status !== "signed_off") openCount++;
    if (s.status === "analyzing") analyzing++;
  });
  const cards = [
    { label: "Open submissions",  value: openCount,        tone: theme.c.text },
    { label: "Critical findings", value: totals.critical,  tone: theme.sev.critical.fg },
    { label: "High findings",     value: totals.high,      tone: theme.sev.high.fg },
    { label: "Scanning now",      value: analyzing,        tone: theme.status.analyzing[theme.mode === "light" ? "light" : "dark"] },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr) 1.4fr", gap: 12, marginBottom: 22 }}>
      {cards.map((c) => (
        <div key={c.label} style={{ padding: "14px 16px", background: theme.c.surface,
          border: `1px solid ${theme.c.border}`, borderRadius: theme.radiusLg }}>
          <div style={{ fontSize: 26, fontWeight: 600, color: c.tone,
            fontFamily: theme.fontDisplay, letterSpacing: "-0.02em", lineHeight: 1 }}>{c.value}</div>
          <div style={{ fontSize: 11.5, color: theme.c.text3, marginTop: 7 }}>{c.label}</div>
        </div>
      ))}
      <div style={{ padding: "14px 16px", background: theme.c.surface,
        border: `1px solid ${theme.c.border}`, borderRadius: theme.radiusLg,
        display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ fontSize: 11.5, color: theme.c.text3, marginBottom: 8 }}>Findings across queue</div>
        <SeverityBar theme={theme} counts={totals} height={8} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          {SEV_ORDER.filter((k) => totals[k] > 0).map((k) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5,
              fontSize: 11, color: theme.c.text2 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: theme.sev[k].solid }} />
              {totals[k]} {theme.sev[k].short.toLowerCase()}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
