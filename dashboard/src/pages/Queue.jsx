import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../App.jsx";
import {
  ActivityFeed, AttentionList, RepoTable, RunTable, SummaryStrip, groupByRepo, refOf, since,
} from "../components/queue/Board.jsx";
import {
  useActiveLlmJobs, useDeleteSubmission, useGroups, useQueueOverview, useSubmissions,
} from "../api/queries.js";
import { errorMessage } from "../api/errors.js";
import { useToast } from "../components/Toast.jsx";

const LOAD_LIMIT = 500;   // API maximum; the board groups and filters these client-side
const PAGE_SIZE  = 60;    // rows shown at a time in "All runs"

const STATUS_CHIPS = [
  { key: "needs_review", label: "Needs review" },
  { key: "scanning",     label: "Scanning",   match: (s) => s === "pending" || s === "analyzing" },
  { key: "signed_off",   label: "Signed off" },
  { key: "error",        label: "Error" },
  { key: null,           label: "All" },
];
const matches = (chip, status) => !chip?.key || (chip.match ? chip.match(status) : chip.key === status);

function readView() {
  try { return localStorage.getItem("custos_queue_view") === "runs" ? "runs" : "repos"; } catch { return "repos"; }
}

export default function Queue() {
  const navigate  = useNavigate();
  const { user }  = useAuth();
  const toast     = useToast();
  const deleteRun = useDeleteSubmission();

  const [view,    setView]    = useState(readView);
  const [chipKey, setChipKey] = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [query,   setQuery]   = useState("");
  const [shown,   setShown]   = useState(PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);

  const { data, isPending, error: queryError, refetch } = useSubmissions(null, groupId, LOAD_LIMIT);
  const { data: overview, refetch: refetchOverview } = useQueueOverview(groupId);
  const { data: groups = [] } = useGroups();
  const { data: activeJobs = new Set() } = useActiveLlmJobs();
  const error = queryError ? errorMessage(queryError, "Failed to load submissions") : null;

  // Admins only; the API enforces it too.
  const onDelete = user?.role === "admin" ? async (s) => {
    try {
      await deleteRun.mutateAsync(s.id);
      toast(`Deleted ${s.repo_full_name.split("/").pop()} ${s.commit_sha.slice(0, 7)}`);
    } catch (e) {
      toast(errorMessage(e, "Delete failed"), { bad: true });
    }
  } : undefined;
  const onOpen = (s) => navigate(`/submissions/${s.id}`);

  const subs  = useMemo(() => data?.submissions || [], [data]);
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
  const pickChip = (k) => { setChipKey((cur) => (cur === k ? null : k)); setShown(PAGE_SIZE); };
  const refresh = async () => {
    setRefreshing(true);
    try { await Promise.all([refetch(), refetchOverview()]); } finally { setRefreshing(false); }
  };
  const rows = view === "repos" ? repoRows : runRows;

  return (
    <div className="page glow">
      <div className="top">
        <div>
          <h1>Review <span className="g">queue</span></h1>
          <div className="subt">
            {isPending ? "Loading…" : (
              <>
                <b>{waiting.length ? `${waiting.length} run${waiting.length !== 1 ? "s" : ""} need review` : "Nothing waiting for review"}</b>
                {waiting.length > 0 && ` · oldest waiting ${since(oldest)}`}
                {scanningNow > 0 && ` · ${scanningNow} scanning now`}
              </>
            )}
          </div>
        </div>
        <div className="tools">
          <input className="input" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE_SIZE); }}
            placeholder="Search repo, branch, commit…" aria-label="Search the queue"
            style={{ width: "clamp(220px, 18vw, 380px)" }} />
          <button className="btn" onClick={refresh} disabled={refreshing}>
            {refreshing ? <><span className="spin" /> Refreshing</> : "↻ Refresh"}
          </button>
          <button className="btn primary" onClick={() => navigate("/repos?add=1")}>+ Add repository</button>
        </div>
      </div>

      {error && <div className="banner bad">{error}</div>}

      <SummaryStrip subs={subs} repos={repos} onChip={pickChip} />

      <div className="cols q">
        <section className="panel">
          <div className="panel-h">
            <div className="seg">
              {[["repos", "By repository"], ["runs", "All runs"]].map(([k, l]) => (
                <button key={k} className={view === k ? "on" : ""} onClick={() => setViewPersist(k)}>{l}</button>
              ))}
            </div>
            <div className="chips">
              {STATUS_CHIPS.map((c) => (
                <button key={String(c.key)} className={`chip ${chipKey === c.key ? "on" : ""}`}
                  onClick={() => { setChipKey(c.key); setShown(PAGE_SIZE); }}>
                  {c.label}{c.key && <span className="n">{countFor(c)}</span>}
                </button>
              ))}
            </div>
            {groups.length > 0 && (
              <div className="chips">
                {[{ id: null, name: "All groups" }, ...groups].map((g) => (
                  <button key={String(g.id)} className={`chip ${groupId === g.id ? "on" : ""}`}
                    onClick={() => { setGroupId(g.id); setShown(PAGE_SIZE); }}>{g.name}</button>
                ))}
              </div>
            )}
          </div>

          {isPending ? (
            <div className="empty">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="empty">
              {subs.length ? "Nothing matches these filters." : (
                <>No scans yet. <button className="link" style={{ color: "var(--accent)" }}
                  onClick={() => navigate("/repos?add=1")}>Add a repository</button> to get started.</>
              )}
            </div>
          ) : view === "repos" ? (
            <RepoTable repos={repoRows} onOpen={onOpen} onDelete={onDelete} activeJobs={activeJobs} />
          ) : (
            <>
              <RunTable subs={runRows.slice(0, shown)} onOpen={onOpen} onDelete={onDelete} activeJobs={activeJobs} />
              {runRows.length > shown && (
                <div style={{ display: "flex", justifyContent: "center", padding: 14 }}>
                  <button className="btn sm" onClick={() => setShown((v) => v + PAGE_SIZE)}>
                    Show more ({runRows.length - shown} remaining)
                  </button>
                </div>
              )}
            </>
          )}
          {data && data.total > subs.length && (
            <div className="muted" style={{ padding: "10px 16px", fontSize: ".8rem", borderTop: "1px solid var(--border)" }}>
              Showing the most relevant {subs.length} of {data.total} runs.
            </div>
          )}
        </section>

        <div className="rail">
          <AttentionList subs={subs} onOpen={onOpen} />
          <ActivityFeed events={overview?.activity || []} onOpen={onOpen} />
        </div>
      </div>
    </div>
  );
}
