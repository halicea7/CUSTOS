import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../App.jsx";
import { Btn } from "../components/atoms.jsx";
import QueueStats from "../components/queue/QueueStats.jsx";
import ViewToggle from "../components/queue/ViewToggle.jsx";
import { QueueCards, QueueRows } from "../components/queue/QueueItems.jsx";
import { useActiveLlmJobs, useGroups, useSubmissions } from "../api/queries.js";
import { errorMessage } from "../api/errors.js";

// ── Page ──────────────────────────────────────────────────────────────────────

const FILTER_OPTS = [
  { key: null,           label: "All" },
  { key: "pending",      label: "Pending" },
  { key: "analyzing",    label: "Analyzing" },
  { key: "needs_review", label: "Needs review" },
  { key: "signed_off",   label: "Signed off" },
  { key: "error",        label: "Error" },
];

const PAGE_SIZE = 60;
const MAX_LIMIT = 500; // API maximum

function readView() {
  try { return localStorage.getItem("custos_queue_view") || "grid"; } catch { return "grid"; }
}

export default function Queue() {
  const { theme } = useTheme();
  const navigate   = useNavigate();

  const [filter,  setFilter]  = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [limit,   setLimit]   = useState(PAGE_SIZE);
  const [view,    setView]    = useState(readView);

  const { data, isFetching, isPending, error: queryError, refetch } = useSubmissions(filter, groupId, limit);
  const { data: groups = [] } = useGroups();
  const { data: activeJobs = new Set() } = useActiveLlmJobs();
  const loading = isPending;
  const error = queryError ? errorMessage(queryError, "Failed to load submissions") : null;

  const changeFilter = (f) => { setFilter(f); setLimit(PAGE_SIZE); };
  const changeGroup  = (g) => { setGroupId(g); setLimit(PAGE_SIZE); };

  const setViewPersist = (v) => {
    setView(v);
    try { localStorage.setItem("custos_queue_view", v); } catch { /* storage unavailable */ }
  };
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
          <Btn theme={t} onClick={() => refetch()} size="sm" disabled={isFetching}>
            {isFetching ? "Refreshing…" : "↻ Refresh"}
          </Btn>
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
            <button key={String(g.id)} onClick={() => changeGroup(g.id)} style={{
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
            <button key={String(fl.key)} onClick={() => changeFilter(fl.key)} style={{
              padding: "6px 14px", fontSize: 11.5, fontWeight: 500,
              fontFamily: t.fontUi, color: active ? t.c.accent : t.c.text2,
              background: active ? t.c.accentBg : "transparent",
              border: `1px solid ${active ? t.c.accent + "66" : t.c.border}`,
              borderRadius: 999, cursor: "pointer", transition: "all 0.14s",
            }}>{fl.label}</button>
          );
        })}
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: t.c.text3,
          fontFamily: t.fontMono }}>{subs.length} of {data?.total ?? 0} shown</span>
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

      {data && subs.length < data.total && limit < MAX_LIMIT && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
          <Btn theme={t} onClick={() => setLimit((l) => Math.min(l + PAGE_SIZE, MAX_LIMIT))} disabled={isFetching}>
            {isFetching ? "Loading…" : `Show more (${data.total - subs.length} remaining)`}
          </Btn>
        </div>
      )}
    </div>
  );
}
