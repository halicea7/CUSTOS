import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { listSubmissions, getActiveLlmJobs, getLlmStatus } from "../api/submissions.js";
import { listGroups } from "../api/groups.js";
import { useTheme, Icon } from "../App.jsx";
import { Severity, SeverityBar, StatusBadge, SEV_ORDER, fmtDate, Btn } from "../components/atoms.jsx";

// ── Stats row ─────────────────────────────────────────────────────────────────

function QueueStats({ theme, submissions }) {
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

// ── View toggle ───────────────────────────────────────────────────────────────

function ViewToggle({ theme, view, setView }) {
  return (
    <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 999,
      background: theme.c.raised2, border: `1px solid ${theme.c.border}` }}>
      {[{ k: "grid", icon: "grid" }, { k: "list", icon: "list" }].map((o) => {
        const on = view === o.k;
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

// ── LLM progress bar shown inside a row ──────────────────────────────────────

function RowLlmBar({ theme, submissionId }) {
  const [llm, setLlm] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await getLlmStatus(submissionId);
        if (!cancelled) {
          setLlm(s);
          if (s.status !== "running" && s.status !== "queued") clearInterval(pollRef.current);
        }
      } catch { /* ignore */ }
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(pollRef.current); };
  }, [submissionId]);

  if (!llm || (llm.status !== "running" && llm.status !== "queued")) return null;
  const pct = llm.status === "queued" ? 4 : Math.round(llm.progress * 100);
  const remaining = llm.status === "running" && llm.estimated > 0
    ? Math.max(0, Math.round(llm.estimated - llm.elapsed)) : null;

  return (
    <div style={{ gridColumn: "1 / -1", paddingTop: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, marginBottom: 4 }}>
        <span style={{ color: theme.c.accent, fontWeight: 600, letterSpacing: "0.04em" }}>
          LLM {llm.status === "queued" ? "QUEUED" : "RUNNING"}
        </span>
        <span style={{ color: theme.c.text3, fontFamily: theme.fontMono }}>
          {llm.status === "running"
            ? `${pct}%${remaining !== null ? ` · ~${remaining}s` : ""}`
            : "waiting for worker"}
        </span>
      </div>
      <div style={{ height: 3, background: theme.c.border, borderRadius: 999, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: theme.c.accent,
          borderRadius: 999, transition: "width 1.8s ease-out",
          animation: llm.status === "queued" ? "shimmer 1.4s ease-in-out infinite" : "none" }} />
      </div>
    </div>
  );
}

// ── Repo cell ─────────────────────────────────────────────────────────────────

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

// ── Card grid view ────────────────────────────────────────────────────────────

function QueueCards({ theme, subs, onOpen, activeJobs }) {
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

// ── Findings cell ─────────────────────────────────────────────────────────────

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

// ── Row list view ─────────────────────────────────────────────────────────────

function QueueRows({ theme, subs, onOpen, activeJobs }) {
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

// ── Page ──────────────────────────────────────────────────────────────────────

const FILTER_OPTS = [
  { key: null,         label: "All" },
  { key: "pending",    label: "Pending" },
  { key: "analyzing",  label: "Analyzing" },
  { key: "reviewed",   label: "Reviewed" },
  { key: "signed_off", label: "Signed off" },
];

export default function Queue() {
  const { theme } = useTheme();
  const navigate   = useNavigate();

  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [filter,     setFilter]     = useState(null);
  const [groupId,    setGroupId]    = useState(null);
  const [groups,     setGroups]     = useState([]);
  const [activeJobs, setActiveJobs] = useState(new Set());
  const [view,       setView]       = useState(() =>
    localStorage.getItem("custos_queue_view") || "grid"
  );
  const activeRef = useRef(null);

  useEffect(() => { listGroups().then(setGroups).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await listSubmissions(filter, groupId);
      setData(res);
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to load submissions");
    } finally { setLoading(false); }
  }, [filter, groupId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const poll = async () => {
      try { const ids = await getActiveLlmJobs(); setActiveJobs(new Set(ids)); }
      catch { /* ignore */ }
    };
    poll();
    activeRef.current = setInterval(poll, 3000);
    return () => clearInterval(activeRef.current);
  }, []);

  const setViewPersist = (v) => { setView(v); localStorage.setItem("custos_queue_view", v); };
  const subs = data?.submissions || [];

  const t = theme;

  return (
    <div style={{ padding: "28px 34px", maxWidth: 1180, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 22 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: t.c.text,
            fontFamily: t.fontDisplay, letterSpacing: "-0.025em" }}>Review queue</h1>
          <div style={{ fontSize: 12.5, color: t.c.text3, marginTop: 4 }}>
            {data ? `${data.total} submission${data.total !== 1 ? "s" : ""}` : "Loading…"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ViewToggle theme={t} view={view} setView={setViewPersist} />
          <Btn theme={t} onClick={load} size="sm" disabled={loading}>↻ Refresh</Btn>
        </div>
      </div>

      {/* Stats */}
      {subs.length > 0 && <QueueStats theme={t} submissions={subs} />}

      {/* Group filter */}
      {groups.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: t.c.text3, letterSpacing: "0.06em", marginRight: 2 }}>
            GROUP
          </span>
          {[{ id: null, name: "All" }, ...groups].map((g) => (
            <button key={String(g.id)} onClick={() => setGroupId(g.id)} style={{
              padding: "3px 10px", borderRadius: 999, cursor: "pointer",
              fontSize: 11, fontFamily: t.fontUi,
              border: groupId === g.id ? `1px solid ${t.c.accent}` : `1px solid ${t.c.border}`,
              background: groupId === g.id ? t.c.accentBg : "transparent",
              color: groupId === g.id ? t.c.accent : t.c.text3, transition: "all 0.1s",
            }}>{g.name}</button>
          ))}
        </div>
      )}

      {/* Status filters */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {FILTER_OPTS.map((fl) => {
          const active = filter === fl.key;
          return (
            <button key={String(fl.key)} onClick={() => setFilter(fl.key)} style={{
              padding: "6px 14px", fontSize: 11.5, fontWeight: 500,
              fontFamily: t.fontUi, color: active ? t.c.accent : t.c.text2,
              background: active ? t.c.accentBg : "transparent",
              border: `1px solid ${active ? t.c.accent + "66" : t.c.border}`,
              borderRadius: 999, cursor: "pointer", transition: "all 0.14s",
            }}>{fl.label}</button>
          );
        })}
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: t.c.text3,
          fontFamily: t.fontMono }}>{subs.length} shown</span>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: "12px 16px", background: `${t.sev.critical.fg}14`,
          border: `1px solid ${t.sev.critical.fg}33`, borderRadius: t.radius,
          color: t.sev.critical.fg, fontSize: 12, marginBottom: 16 }}>{error}</div>
      )}

      {/* Empty */}
      {!loading && subs.length === 0 && !error && (
        <div style={{ padding: "60px 24px", textAlign: "center", color: t.c.text3,
          fontSize: 13, background: t.c.surface, border: `1px solid ${t.c.border}`,
          borderRadius: t.radiusLg }}>No submissions found.</div>
      )}

      {/* List */}
      {subs.length > 0 && (
        view === "grid"
          ? <QueueCards theme={t} subs={subs} onOpen={(s) => navigate(`/submissions/${s.id}`)} activeJobs={activeJobs} />
          : <QueueRows  theme={t} subs={subs} onOpen={(s) => navigate(`/submissions/${s.id}`)} activeJobs={activeJobs} />
      )}
    </div>
  );
}
