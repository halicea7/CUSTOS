// Submission renderings for the queue: card grid and row list.
import React, { useState } from "react";
import { Severity, SeverityBar, StatusBadge, SEV_ORDER, fmtDate } from "../atoms.jsx";

function RepoCell({ theme, sub }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: theme.c.text, fontSize: 13.5, fontWeight: 600,
        fontFamily: theme.fontDisplay, letterSpacing: "-0.01em",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {sub.repo_full_name || "—"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
        <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.c.text3 }}>
          {sub.commit_sha?.slice(0, 8)}
        </span>
        {sub.branch && (
          <>
            <span style={{ color: theme.c.border2 }}>·</span>
            <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.c.link,
              background: theme.mode === "light" ? "#eef2fd" : "rgba(56,139,253,0.1)",
              padding: "0 7px", borderRadius: 4, border: `1px solid ${theme.c.link}22`,
              maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {sub.branch}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function FindingsCell({ theme, sub, isLlmActive }) {
  const t = theme;
  const counts = sub.finding_counts || {};
  const total  = SEV_ORDER.reduce((a, k) => a + (counts[k] || 0), 0);
  const isAnalyzing = sub.status === "analyzing";

  if (isLlmActive) {
    return (
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, marginBottom: 5 }}>
          <span style={{ color: t.c.accent, fontWeight: 600, letterSpacing: "0.04em" }}>LLM RUNNING</span>
        </div>
        <div style={{ height: 3, background: t.c.border, borderRadius: 999 }}>
          <div style={{ height: "100%", width: "60%", background: t.c.accent,
            borderRadius: 999, animation: "shimmer 1.4s ease-in-out infinite" }} />
        </div>
      </div>
    );
  }
  if (isAnalyzing) {
    return (
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, marginBottom: 5 }}>
          <span style={{ color: t.c.accent, fontWeight: 600, letterSpacing: "0.04em" }}>ANALYZING</span>
        </div>
        <div style={{ height: 3, background: t.c.border, borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: "50%", background: t.c.accent,
            borderRadius: 999, animation: "shimmer 2s ease-in-out infinite" }} />
        </div>
      </div>
    );
  }
  if (total > 0) {
    return (
      <div style={{ minWidth: 0 }}>
        <SeverityBar theme={t} counts={counts} height={6} />
        <div style={{ display: "flex", gap: 7, marginTop: 7, flexWrap: "wrap" }}>
          {SEV_ORDER.filter((k) => counts[k] > 0).map((k) => (
            <Severity key={k} theme={t} severity={k} count={counts[k]} />
          ))}
        </div>
      </div>
    );
  }
  if (sub.finding_counts !== null && sub.finding_counts !== undefined) {
    const green = t.status.signed_off[t.mode === "light" ? "light" : "dark"];
    return <span style={{ fontSize: 12, color: green, fontWeight: 500 }}>Clean</span>;
  }
  return <span style={{ color: t.c.text3, fontSize: 12 }}>—</span>;
}

export function QueueCards({ theme, subs, onOpen, activeJobs }) {
  const [hover, setHover] = useState(null);
  const t = theme;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 16 }}>
      {subs.map((sub) => {
        const isLlmActive = activeJobs.has(sub.id);
        const hov = hover === sub.id;
        const counts = sub.finding_counts || {};
        const topSev = SEV_ORDER.find((k) => counts[k] > 0);
        return (
          <div key={sub.id} onClick={() => onOpen(sub)}
            onMouseEnter={() => setHover(sub.id)} onMouseLeave={() => setHover(null)}
            style={{ background: t.c.surface,
              border: `1px solid ${hov ? t.c.border2 : t.c.border}`,
              borderRadius: t.radiusLg, padding: 20, cursor: "pointer",
              transition: "all 0.16s", transform: hov ? "translateY(-3px)" : "none",
              boxShadow: hov ? t.c.shadowHi : t.c.shadow,
              display: "flex", flexDirection: "column", gap: 14,
              borderTop: topSev ? `3px solid ${t.sev[topSev].solid}` : `3px solid ${t.c.border2}` }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
              <RepoCell theme={t} sub={sub} />
              <StatusBadge theme={t} status={sub.status} />
            </div>
            <FindingsCell theme={t} sub={sub} isLlmActive={isLlmActive} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12,
              color: t.c.text3, marginTop: "auto", paddingTop: 10,
              borderTop: `1px solid ${t.c.border}` }}>
              <span style={{ color: t.c.text2, fontWeight: 500 }}>
                {sub.submitter || sub.github_actor || "—"}
              </span>
              <span style={{ marginLeft: "auto" }}>{fmtDate(sub.created_at)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function QueueRows({ theme, subs, onOpen, activeJobs }) {
  const [hover, setHover] = useState(null);
  const COLS = "1.8fr 1fr 190px 130px";
  return (
    <div style={{ border: `1px solid ${theme.c.border}`, borderRadius: theme.radiusLg, overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "9px 18px",
        background: theme.c.raised, borderBottom: `1px solid ${theme.c.border}` }}>
        {["Repo / commit", "Findings", "Submitted by", "Status"].map((h, i) => (
          <span key={h} style={{ fontSize: 10, color: theme.c.text3, letterSpacing: "0.1em",
            fontWeight: 700, textTransform: "uppercase", fontFamily: theme.fontMono,
            textAlign: i === 3 ? "right" : "left" }}>{h}</span>
        ))}
      </div>
      {subs.map((sub, i) => {
        const isLlmActive = activeJobs.has(sub.id);
        const hov = hover === sub.id;
        return (
          <div key={sub.id} onClick={() => onOpen(sub)}
            onMouseEnter={() => setHover(sub.id)} onMouseLeave={() => setHover(null)}
            style={{ display: "grid", gridTemplateColumns: COLS,
              gap: 12, padding: "14px 18px", alignItems: "center", cursor: "pointer",
              borderBottom: i < subs.length - 1 ? `1px solid ${theme.c.border}` : "none",
              borderLeft: `2px solid ${isLlmActive ? theme.c.accent : "transparent"}`,
              background: hov ? theme.c.raised : theme.c.surface, transition: "background 0.12s" }}>
            <RepoCell theme={theme} sub={sub} />
            <FindingsCell theme={theme} sub={sub} isLlmActive={isLlmActive} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: theme.c.text2, whiteSpace: "nowrap",
                overflow: "hidden", textOverflow: "ellipsis" }}>
                {sub.submitter || sub.github_actor || "—"}
              </div>
              <div style={{ fontSize: 11, color: theme.c.text3, marginTop: 2 }}>
                {fmtDate(sub.created_at)}
              </div>
            </div>
            <div style={{ justifySelf: "end" }}>
              <StatusBadge theme={theme} status={sub.status} size="lg" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
