import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  addRepoToGroup, checkRepoUpdates, deleteRepo, removeRepoFromGroup, updateRepo,
} from "../api/repos.js";
import { keys, useGroups, useRepos, useSubmissions } from "../api/queries.js";
import { errorMessage } from "../api/errors.js";
import { useAuth } from "../App.jsx";
import { ArmedButton, SevNum, Status, Trend, ago, groupByRepo, n } from "../components/queue/Board.jsx";
import AddRepoModal from "../components/AddRepoModal.jsx";
import { useToast } from "../components/Toast.jsx";

const DAY = 86400000;
const SOON = 14; // days before a token's expiry that it gets flagged
const plural = (k, w, many = `${w}s`) => `${k} ${k === 1 ? w : many}`;

const daysLeft = (ts) => (ts ? Math.ceil((new Date(ts) - Date.now()) / DAY) : null);

function TokenExpiry({ expiresAt }) {
  const d = daysLeft(expiresAt);
  if (d === null) return null;
  const when = new Date(expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (d <= 0) return <span className="pill" title={`Expired ${when}`} style={{ color: "var(--crit)", background: "var(--crit-bg)" }}>expired</span>;
  if (d <= SOON) return <span className="pill" title={`Expires ${when}`} style={{ color: "var(--high)", background: "var(--high-bg)" }}>expires in {d}d</span>;
  return <span className="muted" title={`Expires ${when}`} style={{ fontSize: ".8rem" }}>{d}d left</span>;
}

function checkSummary(result) {
  const k = result.queued.length;
  if (!k) return "Up to date: no new commits.";
  return `Queued ${plural(k, "scan")}: ${result.queued.map((q) => (q.pr_number ? `PR #${q.pr_number}` : q.branch)).join(", ")}`;
}

function RepoRow({ repo, runs, groups, canManage, onChanged }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const latest = runs[0];
  const open = latest?.status === "needs_review";
  const assigned = new Set((repo.groups || []).map((g) => g.id));
  const choices = groups.filter((g) => !assigned.has(g.id));
  const short = repo.repo_full_name.split("/").pop();

  const act = async (fn, done, fail) => {
    try { await fn(); toast(done); onChanged(); } catch (e) { toast(errorMessage(e, fail), { bad: true }); }
  };
  const checkNow = async (e) => {
    e.stopPropagation();
    setChecking(true); setMsg(null);
    try {
      const result = await checkRepoUpdates(repo.id);
      setMsg({ ok: true, text: checkSummary(result) });
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err, "Check failed") });
    } finally { setChecking(false); }
  };
  const stop = (e) => e.stopPropagation();

  return (
    <tr className={`click ${repo.enabled ? "" : "dim-row"}`} onClick={() => latest && navigate(`/submissions/${latest.id}`)}
      title={latest ? "Open the latest scan" : undefined}>
      <td>
        <div className="rname" style={{ cursor: "inherit" }}>{repo.repo_full_name}</div>
        <div className="rmeta" onClick={stop}>
          {(repo.groups || []).map((g) => (
            <span key={g.id} className="gtag">{g.name}
              {canManage && (
                <button aria-label={`Remove from ${g.name}`} title={`Remove from ${g.name}`}
                  onClick={() => act(() => removeRepoFromGroup(repo.id, g.id), `Removed ${short} from ${g.name}`, "Couldn't update groups")}>×</button>
              )}
            </span>
          ))}
          {canManage && choices.length > 0 && (
            <select className="select-pill" value="" aria-label="Share with a group"
              onChange={(e) => {
                const g = groups.find((x) => x.id === e.target.value);
                if (g) act(() => addRepoToGroup(repo.id, g.id), `Shared ${short} with ${g.name}`, "Couldn't update groups");
              }}>
              <option value="">+ group</option>
              {choices.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <span>· added by {repo.added_by}</span>
        </div>
        {msg && <div className="rmeta" role="status" style={{ color: msg.ok ? "var(--accent)" : "var(--crit)" }}>{msg.text}</div>}
      </td>
      <td className="hide-sm">
        {latest ? <><Status status={latest.status} /><div className="muted" style={{ fontSize: ".78rem" }}>{ago(latest.created_at)}</div></> : <span className="muted">no scans yet</span>}
      </td>
      <td className="num">{open ? <SevNum sev="critical" value={n(latest, "critical")} /> : <span className="sev z">·</span>}</td>
      <td className="num">{open ? <SevNum sev="high" value={n(latest, "high")} /> : <span className="sev z">·</span>}</td>
      <td className="hide-sm"><Trend runs={runs} /></td>
      <td style={{ whiteSpace: "nowrap" }}>
        <span className="mono muted" style={{ fontSize: ".8rem" }}>{repo.token_preview || "—"}</span>{" "}
        <TokenExpiry expiresAt={repo.token_expires_at} />
      </td>
      <td className="hide-sm" style={{ whiteSpace: "nowrap" }}
        title={repo.last_push_at ? `Last scan queued ${new Date(repo.last_push_at).toLocaleString()}` : undefined}>
        {repo.last_checked_at ? ago(repo.last_checked_at) : "never"}
      </td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={stop}>
        <button className="btn sm" disabled={checking || !repo.enabled} onClick={checkNow}>
          {checking ? <><span className="spin" /> Checking</> : "↻ Check for updates"}
        </button>
        <button className={`toggle ${repo.enabled ? "on" : ""}`} style={{ margin: "0 10px", verticalAlign: "middle" }}
          aria-pressed={repo.enabled} title={repo.enabled ? "Enabled: click to stop scanning" : "Disabled: click to resume scanning"}
          onClick={() => act(() => updateRepo(repo.id, { enabled: !repo.enabled }),
            `${short} ${repo.enabled ? "disabled" : "enabled"}`, "Couldn't update the repository")}>
          <span className="switch" />
        </button>
        <ArmedButton label="Remove" confirm="Confirm remove"
          onConfirm={() => act(() => deleteRepo(repo.id), `Removed ${repo.repo_full_name}`, "Couldn't remove the repository")} />
      </td>
    </tr>
  );
}

export default function Repos() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const { data: repos = [], isPending, error } = useRepos();
  const { data: groups = [] } = useGroups();
  const { data: subsData } = useSubmissions(null, null, 500);
  const runsByRepo = useMemo(
    () => new Map(groupByRepo(subsData?.submissions || []).map((r) => [r.name, r.runs])),
    [subsData],
  );

  // /repos?add=1 (from the queue and the command palette) opens the dialog.
  useEffect(() => {
    if (params.get("add")) { setShowAdd(true); setParams({}, { replace: true }); }
  }, [params, setParams]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.repos });
    qc.invalidateQueries({ queryKey: ["submissions"] });
  };

  const q = query.trim().toLowerCase();
  const rows = repos.filter((r) => !q || r.repo_full_name.toLowerCase().includes(q));
  const expiring = repos.filter((r) => { const d = daysLeft(r.token_expires_at); return d !== null && d <= SOON; }).length;

  return (
    <div className="page glow">
      <div className="top">
        <div>
          <h1>Repositories</h1>
          <div className="subt">
            {plural(repos.length, "repository", "repositories")} · checked for new commits on a schedule or on demand
            {expiring > 0 && <span style={{ color: "var(--high)" }}> · {plural(expiring, "token")} expired or expiring soon</span>}
          </div>
        </div>
        <div className="tools">
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repositories…" aria-label="Search repositories" style={{ width: "clamp(200px,16vw,340px)" }} />
          <button className="btn primary" onClick={() => setShowAdd(true)}>+ Add repository</button>
        </div>
      </div>

      {error && <div className="banner bad">{errorMessage(error, "Failed to load repositories")}</div>}

      <section className="panel">
        {isPending ? <div className="empty">Loading…</div> : repos.length === 0 ? (
          <div className="empty">
            No repositories connected yet.{" "}
            <button className="link" style={{ color: "var(--accent)" }} onClick={() => setShowAdd(true)}>Add your first one</button>
          </div>
        ) : rows.length === 0 ? <div className="empty">No repositories match &ldquo;{query}&rdquo;.</div> : (
          <table className="tbl">
            <thead><tr>
              <th>Repository</th><th className="hide-sm">Latest scan</th>
              <th className="num">Crit</th><th className="num">High</th><th className="hide-sm">Trend</th>
              <th>Token</th><th className="hide-sm">Last checked</th><th />
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <RepoRow key={r.id} repo={r} runs={runsByRepo.get(r.repo_full_name) || []} groups={groups}
                  canManage={user?.role === "admin" || r.added_by === user?.username} onChanged={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showAdd && <AddRepoModal onClose={() => setShowAdd(false)} onAdded={refresh} />}
    </div>
  );
}
