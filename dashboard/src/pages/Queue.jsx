import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useTheme, useAuth } from "../App.jsx";
import { Btn } from "../components/atoms.jsx";
import {
  ActivityFeed, AttentionList, Panel, RepoTable, RunTable, SummaryStrip, ago, groupByRepo, refOf,
} from "../components/queue/Board.jsx";
import {
  useActiveLlmJobs, useDeleteSubmission, useGroups, useQueueOverview, useSubmissions,
} from "../api/queries.js";
import { errorMessage } from "../api/errors.js";

const LOAD_LIMIT = 500;   // API maximum; the board groups and filters these client-side
const PAGE_SIZE  = 60;    // rows shown at a time in "All runs"

const STATUS_CHIPS = [
  { key: "needs_review", label: "Needs review" },
  { key: "scanning",     label: "Scanning",   match: (s) => s === "pending" || s === "analyzing" },
  { key: "signed_off",   label: "Signed off" },
  { key: "error",        label: "Error" },
  { key: null,           label: "All" },
];
const matches = (chip, status) => !chip.key || (chip.match ? chip.match(status) : chip.key === status);

// Breakpoints the inline styles can't express.
const CSS = `
.q-strip { display:grid; grid-template-columns:repeat(4, minmax(150px,1fr)) minmax(300px,1.6fr); gap:12px; margin-bottom:22px; }
.q-cols { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:20px; align-items:start; }
.q-rail { display:flex; flex-direction:column; gap:20px; position:sticky; top:20px; }
.q-hist { display:grid; grid-template-columns:90px 90px 170px minmax(80px,1fr) 80px 120px; gap:12px; align-items:center; padding:7px 0; font-size:12.5px; }
@media (max-width:1180px) {
  .q-cols { grid-template-columns:1fr; } .q-rail { position:static; }
  .q-strip { grid-template-columns:repeat(2,1fr); } .q-wide { grid-column:1/-1; }
}
@media (max-width:760px) {
  .q-hide-sm { display:none; }
  .q-hist { grid-template-columns:80px 1fr 90px; } .q-hist > :nth-child(3), .q-hist > :nth-child(4) { display:none; }
}`;

function Chip({ theme: t, on, onClick, children, count }) {
  return (
    <button onClick={onClick} style={{
      border: `1px solid ${on ? t.c.accent : t.c.border}`, background: on ? t.c.accentBg : "transparent",
      color: on ? t.c.text : t.c.text2, borderRadius: 999, padding: "3px 10px", fontSize: 12,
      fontFamily: t.fontUi, cursor: "pointer", whiteSpace: "nowrap",
    }}>
      {children}{count != null && <span style={{ color: t.c.text3, marginLeft: 5 }}>{count}</span>}
    </button>
  );
}

function Segmented({ theme: t, value, onChange, options }) {
  return (
    <div style={{ display: "flex", background: t.c.raised2, borderRadius: 8, padding: 3, gap: 2 }}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <button key={o.key} onClick={() => onChange(o.key)} style={{
            border: 0, borderRadius: 6, padding: "4px 10px", fontSize: 12.5, cursor: "pointer",
            fontFamily: t.fontUi, background: on ? t.c.surface : "transparent",
            color: on ? t.c.text : t.c.text2, fontWeight: on ? 600 : 400, boxShadow: on ? t.c.shadow : "none",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

function readView() {
  try { return localStorage.getItem("custos_queue_view") === "runs" ? "runs" : "repos"; } catch { return "repos"; }
}

export default function Queue() {
  const { theme: t } = useTheme();
  const navigate     = useNavigate();
  const { user }     = useAuth();
  const deleteRun    = useDeleteSubmission();

  const [view,    setView]    = useState(readView);
  const [chipKey, setChipKey] = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [query,   setQuery]   = useState("");
  const [shown,   setShown]   = useState(PAGE_SIZE);

  const { data, isFetching, isPending, error: queryError, refetch } = useSubmissions(null, groupId, LOAD_LIMIT);
  const { data: overview } = useQueueOverview(groupId);
  const { data: groups = [] } = useGroups();
  const { data: activeJobs = new Set() } = useActiveLlmJobs();
  const error = queryError ? errorMessage(queryError, "Failed to load submissions") : null;

  // Admins only; the API enforces it too.
  const onDelete = user?.role === "admin" ? (s) => deleteRun.mutateAsync(s.id) : undefined;
  const onOpen   = (s) => navigate(`/submissions/${s.id}`);

  const subs = useMemo(() => data?.submissions || [], [data]);
  const repos = useMemo(() => groupByRepo(subs), [subs]);

  const q = query.trim().toLowerCase();
  const hit = (s) => !q || [s.repo_full_name, refOf(s), s.commit_sha, s.submitter, s.github_actor]
    .some((v) => v && String(v).toLowerCase().includes(q));
  const chip = STATUS_CHIPS.find((c) => c.key === chipKey);

  // By repository, a chip filters on each repo's latest run; in All runs, on every run.
  const repoRows = repos.filter((r) => matches(chip, r.latest.status) && r.runs.some(hit));
  const runRows  = [...subs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .filter((s) => matches(chip, s.status) && hit(s));
  const countFor = (c) => (view === "repos"
    ? repos.filter((r) => matches(c, r.latest.status)).length
    : subs.filter((s) => matches(c, s.status)).length);

  const waiting = subs.filter((s) => s.status === "needs_review");
  const oldest  = waiting.reduce((m, s) => Math.min(m, new Date(s.created_at).getTime()), Infinity);
  const scanningNow = subs.filter((s) => s.status === "analyzing").length;

  const setViewPersist = (v) => {
    setView(v); setShown(PAGE_SIZE);
    try { localStorage.setItem("custos_queue_view", v); } catch { /* storage unavailable */ }
  };

  return (
    <div style={{ padding: "26px 32px 48px", maxWidth: 1640, margin: "0 auto" }}>
      <style>{CSS}</style>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16,
        marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: t.c.text, fontFamily: t.fontDisplay,
            letterSpacing: "-0.02em" }}>Review queue</h1>
          <div style={{ fontSize: 13, color: t.c.text2, marginTop: 3 }}>
            {isPending ? "Loading…" : (
              <>
                <b style={{ color: t.c.text, fontWeight: 600 }}>
                  {waiting.length ? `${waiting.length} run${waiting.length !== 1 ? "s" : ""} need review` : "Nothing waiting for review"}
                </b>
                {waiting.length > 0 && ` · oldest waiting ${ago(oldest).replace(" ago", "")}`}
                {scanningNow > 0 && ` · ${scanningNow} scanning now`}
              </>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE_SIZE); }}
            placeholder="Search repo, branch, commit…" aria-label="Search the queue"
            style={{ background: t.c.surface, border: `1px solid ${t.c.border}`, borderRadius: 9,
              padding: "7px 11px", color: t.c.text, fontFamily: t.fontUi, fontSize: 13, width: 260, outline: "none" }} />
          <Btn theme={t} onClick={() => refetch()} size="sm" disabled={isFetching}>
            {isFetching ? "Refreshing…" : "↻ Refresh"}
          </Btn>
        </div>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", marginBottom: 16, background: t.sev.critical.bg,
          border: `1px solid ${t.sev.critical.fg}33`, borderRadius: t.radius, color: t.sev.critical.fg, fontSize: 13 }}>
          {error}
        </div>
      )}

      <SummaryStrip theme={t} subs={subs} repos={repos} />

      <div className="q-cols">
        <Panel theme={t}
          title={<Segmented theme={t} value={view} onChange={setViewPersist}
            options={[{ key: "repos", label: "By repository" }, { key: "runs", label: "All runs" }]} />}
          right={
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {STATUS_CHIPS.map((c) => (
                  <Chip key={String(c.key)} theme={t} on={chipKey === c.key}
                    onClick={() => { setChipKey(c.key); setShown(PAGE_SIZE); }}
                    count={c.key ? countFor(c) : null}>{c.label}</Chip>
                ))}
              </div>
              {groups.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[{ id: null, name: "All groups" }, ...groups].map((g) => (
                    <Chip key={String(g.id)} theme={t} on={groupId === g.id}
                      onClick={() => { setGroupId(g.id); setShown(PAGE_SIZE); }}>{g.name}</Chip>
                  ))}
                </div>
              )}
            </div>
          }>
          {isPending ? (
            <div style={{ padding: 40, textAlign: "center", color: t.c.text3, fontSize: 13 }}>Loading…</div>
          ) : (view === "repos" ? repoRows : runRows).length === 0 ? (
            <div style={{ padding: "48px 24px", textAlign: "center", color: t.c.text3, fontSize: 13 }}>
              {subs.length ? "Nothing matches these filters." : "No scans yet. Add a repository to get started."}
            </div>
          ) : view === "repos" ? (
            <RepoTable theme={t} repos={repoRows} onOpen={onOpen} onDelete={onDelete} activeJobs={activeJobs} />
          ) : (
            <>
              <RunTable theme={t} subs={runRows.slice(0, shown)} onOpen={onOpen} onDelete={onDelete} activeJobs={activeJobs} />
              {runRows.length > shown && (
                <div style={{ display: "flex", justifyContent: "center", padding: 14 }}>
                  <Btn theme={t} size="sm" onClick={() => setShown((v) => v + PAGE_SIZE)}>
                    Show more ({runRows.length - shown} remaining)
                  </Btn>
                </div>
              )}
            </>
          )}
          {data && data.total > subs.length && (
            <div style={{ padding: "10px 16px", fontSize: 12, color: t.c.text3, borderTop: `1px solid ${t.c.border}` }}>
              Showing the most relevant {subs.length} of {data.total} runs.
            </div>
          )}
        </Panel>

        <div className="q-rail">
          <AttentionList theme={t} subs={subs} onOpen={onOpen} />
          <ActivityFeed theme={t} events={overview?.activity || []} onOpen={onOpen} />
        </div>
      </div>
    </div>
  );
}
