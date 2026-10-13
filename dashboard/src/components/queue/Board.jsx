// Queue page pieces: summary strip, repository table, run table and the
// right-hand rail (needs attention, recent activity). Styles: styles.css.
import React, { useState } from "react";
import { STATUS_META } from "../../theme.js";

const COUNTED = ["critical", "high", "medium", "low"];
const SHORT = { critical: "Crit", high: "High", medium: "Med", low: "Low" };
const VAR = { critical: "crit", high: "high", medium: "med", low: "low", info: "info" };
const IN_PROGRESS = new Set(["pending", "analyzing"]);
const DONE = new Set(["needs_review", "awaiting_approval", "signed_off"]);
const DAY = 86400000;
const OLD_AFTER = 2 * DAY;  // waiting longer than this is called out

export const total = (s) => COUNTED.reduce((a, k) => a + (s.finding_counts?.[k] || 0), 0);
export const n = (s, k) => s.finding_counts?.[k] || 0;
export const refOf = (s) => (s.pr_number ? `PR #${s.pr_number}` : s.branch || "—");
export const sevVar = (k) => VAR[k] || "info";

export function ago(ts) {
  if (!ts) return "—";
  const sec = (Date.now() - new Date(ts)) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
export const since = (ts) => ago(ts).replace(" ago", "");
const plural = (k, w) => `${k} ${w}${k !== 1 ? "s" : ""}`;

/** Group runs by repo, newest first within each; repos ordered by latest run. */
export function groupByRepo(subs) {
  const map = new Map();
  [...subs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).forEach((s) => {
    if (!map.has(s.repo_full_name)) map.set(s.repo_full_name, []);
    map.get(s.repo_full_name).push(s);
  });
  return [...map.entries()].map(([name, runs]) => ({ name, runs, latest: runs[0] }));
}

// ── Small pieces (also used by the Repos page) ──────────────────────────────

export function Status({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  const color = { pending: "var(--text3)", analyzing: "var(--run)", needs_review: "var(--med)",
    awaiting_approval: "var(--low)",
    signed_off: "var(--ok)", error: "var(--crit)" }[status] || "var(--text3)";
  return (
    <span className="status">
      <span className={`dot ${status === "analyzing" ? "pulse" : ""}`} style={{ background: color }} />
      {meta.label}
    </span>
  );
}

export function SevNum({ sev, value }) {
  if (!value) return <span className="sev z">·</span>;
  if (sev === "critical") return <span className="sev" style={{ color: "var(--crit)" }}><span className="crit-cell">{value}</span></span>;
  return <span className="sev" style={{ color: `var(--${sevVar(sev)})` }}>{value}</span>;
}

export function Trend({ runs }) {
  // Oldest → newest totals of finished runs.
  const vals = runs.filter((r) => DONE.has(r.status)).slice(0, 6).reverse().map(total);
  if (vals.length < 2) return <span className="muted">—</span>;
  const mx = Math.max(...vals, 1);
  return (
    <div className="trend" title={`Findings over the last ${vals.length} runs: ${vals.join(" → ")}`}>
      {vals.map((v, i) => (
        <span key={i} className={i === vals.length - 1 ? "last" : ""} style={{ height: `${Math.max(8, (v / mx) * 100)}%` }} />
      ))}
    </div>
  );
}

export function MiniBar({ sub }) {
  const tot = total(sub);
  return (
    <div className="minibar" title={COUNTED.map((k) => `${n(sub, k)} ${k}`).join(", ")}>
      {tot > 0 && COUNTED.map((k) => n(sub, k) > 0 && (
        <span key={k} style={{ width: `${(n(sub, k) / tot) * 100}%`, background: `var(--${sevVar(k)}-solid)` }} />
      ))}
    </div>
  );
}

export const Ref = ({ sub }) => <span className="tag">{refOf(sub)}</span>;

// "Delete" → "Confirm delete" (3s) → onDelete. Clicks don't open the row.
export function ArmedButton({ label = "Delete", confirm = "Confirm delete", onConfirm, className = "link red" }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const click = async (e) => {
    e.stopPropagation();
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); setArmed(false); }
  };
  return (
    <button className={`${className} ${armed ? "armed" : ""}`} disabled={busy} onClick={click}>
      {busy ? "…" : armed ? confirm : label}
    </button>
  );
}

function RunStatus({ sub, llmActive }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Status status={sub.status} />
      {llmActive && <span style={{ fontSize: ".75rem", color: "var(--accent)" }}>LLM re-run…</span>}
    </span>
  );
}

const canDelete = (s) => !IN_PROGRESS.has(s.status);

// ── Summary strip ────────────────────────────────────────────────────────────

function ScanChart({ subs }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => ({ start: today.getTime() - (13 - i) * DAY, runs: 0, crit: 0 }));
  let errors = 0, inRange = 0;
  subs.forEach((s) => {
    const ts = new Date(s.created_at).getTime();
    const d = days.find((x) => ts >= x.start && ts < x.start + DAY);
    if (!d) return;
    d.runs++; inRange++;
    if (n(s, "critical")) d.crit++;
    if (s.status === "error") errors++;
  });
  const mx = Math.max(...days.map((d) => d.runs), 1);
  return (
    <div className="tile wide">
      <div className="k">Scans · last 14 days</div>
      <div className="spark">
        {days.map((d) => (
          <div key={d.start} className={d.runs ? "" : "none"}
            title={`${new Date(d.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${plural(d.runs, "run")}${d.crit ? `, ${d.crit} with critical` : ""}`}
            style={{ height: `${d.runs ? Math.max(8, (d.runs / mx) * 100) : 4}%` }}>
            {d.crit > 0 && <i style={{ height: `${(d.crit / d.runs) * 100}%` }} />}
          </div>
        ))}
      </div>
      <div className="legend">
        <span style={{ color: "var(--accent)" }}>▮ runs</span><span style={{ color: "var(--crit)" }}>▮ with critical</span>
        <span style={{ marginLeft: "auto" }}>{plural(inRange, "run")} · {plural(errors, "error")}</span>
      </div>
    </div>
  );
}

export function SummaryStrip({ subs, repos, onChip, admin }) {
  const waiting = subs.filter((s) => s.status === "needs_review");
  const approvals = admin ? subs.filter((s) => s.status === "awaiting_approval").length : 0;
  const oldest = waiting.reduce((m, s) => Math.min(m, new Date(s.created_at).getTime()), Infinity);
  // Open findings: each repo's latest run that's still awaiting review.
  const open = repos.map((r) => r.latest).filter((s) => s.status === "needs_review");
  const crit = open.reduce((a, s) => a + n(s, "critical"), 0);
  const high = open.reduce((a, s) => a + n(s, "high"), 0);
  const scanning = subs.filter((s) => s.status === "analyzing");
  const queued = subs.filter((s) => s.status === "pending").length;
  const longWait = waiting.length && Date.now() - oldest > OLD_AFTER;
  return (
    <div className="strip" data-tour="queue-summary">
      <button className="tile hero" onClick={() => onChip("needs_review")} title="Show runs that need review">
        <div className="k"><span className="dot" style={{ background: "var(--accent)" }} />Needs review</div>
        <div className="v">{waiting.length}</div>
        <div className="h" style={longWait ? { color: "var(--high)" } : undefined}>
          {waiting.length ? `oldest waiting ${since(oldest)}` : "all caught up"}
          {approvals > 0 && ` · ${approvals} to approve`}
        </div>
      </button>
      <button className="tile" onClick={() => onChip("needs_review")}>
        <div className="k"><span className="dot" style={{ background: "var(--crit)" }} />Open critical</div>
        <div className="v" style={crit ? { color: "var(--crit)" } : undefined}>{crit}</div>
        <div className="h">{crit ? `across ${plural(open.filter((s) => n(s, "critical")).length, "repo")}` : "none open"}</div>
      </button>
      <button className="tile" onClick={() => onChip("needs_review")}>
        <div className="k"><span className="dot" style={{ background: "var(--high)" }} />Open high</div>
        <div className="v">{high}</div>
        <div className="h">{high ? `across ${plural(open.filter((s) => n(s, "high")).length, "repo")}` : "none open"}</div>
      </button>
      <button className="tile" onClick={() => onChip("scanning")}>
        <div className="k"><span className={`dot ${scanning.length ? "pulse" : ""}`} style={{ background: "var(--run)" }} />Scanning now</div>
        <div className="v">{scanning.length}</div>
        <div className="h">{scanning.length
          ? `${scanning[0].repo_full_name.split("/").pop()} · ${since(scanning[0].updated_at)} in`
          : queued ? `${queued} queued` : "idle"}</div>
      </button>
      <ScanChart subs={subs} />
    </div>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

function SevCells({ sub }) {
  return COUNTED.map((k) => (
    <td key={k} className="num">{DONE.has(sub.status) ? <SevNum sev={k} value={n(sub, k)} /> : ""}</td>
  ));
}

function RepoRow({ repo, expanded, onToggle, onOpen, onDelete, activeJobs }) {
  const s = repo.latest;
  const many = repo.runs.length > 1;
  const waitingLong = s.status === "needs_review" && Date.now() - new Date(s.created_at) > OLD_AFTER;
  return (
    <>
      <tr className={`click ${expanded ? "open" : ""}`} onClick={() => (many ? onToggle() : onOpen(s))}>
        <td>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
            <span className="chev">{many ? "›" : ""}</span>
            <div style={{ minWidth: 0 }}>
              <button className="rname" onClick={(e) => { e.stopPropagation(); onOpen(s); }} title="Open the latest run">
                {repo.name}
              </button>
              <div className="rmeta">
                <Ref sub={s} /><span className="mono">{s.commit_sha.slice(0, 7)}</span>
                {many && <span>· {repo.runs.length} runs</span>}
                {s.status === "error" && s.error_message && (
                  <span title={s.error_message} style={{ color: "var(--crit)", maxWidth: 380, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {s.error_message}</span>
                )}
              </div>
            </div>
          </div>
        </td>
        <td className="hide-sm"><RunStatus sub={s} llmActive={activeJobs.has(s.id)} /></td>
        <td className="xl" style={{ width: "13%" }}>{DONE.has(s.status) && <MiniBar sub={s} />}</td>
        <SevCells sub={s} />
        <td className="hide-sm"><Trend runs={repo.runs} /></td>
        <td className="xl">{s.submitter || s.github_actor || "—"}</td>
        <td style={{ whiteSpace: "nowrap", color: waitingLong ? "var(--high)" : undefined }}>{ago(s.created_at)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} style={{ padding: 0 }}>
            <div className="hist">
              {repo.runs.map((r) => (
                <div key={r.id} className="hist-row" onClick={() => onOpen(r)}>
                  <span className="mono dim">{r.commit_sha.slice(0, 7)}</span>
                  <span><Ref sub={r} /></span>
                  <RunStatus sub={r} llmActive={activeJobs.has(r.id)} />
                  {DONE.has(r.status) ? <MiniBar sub={r} /> : <span />}
                  <span className="dim">{ago(r.created_at)}</span>
                  <span style={{ justifySelf: "end" }}>
                    {onDelete && canDelete(r) && <ArmedButton onConfirm={() => onDelete(r)} />}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function RepoTable({ repos, onOpen, onDelete, activeJobs }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (name) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return (
    <table className="tbl">
      <thead><tr>
        <th style={{ paddingLeft: "2.4rem" }}>Repository</th>
        <th className="hide-sm">Latest run</th>
        <th className="xl">Findings</th>
        {COUNTED.map((k) => <th key={k} className="num">{SHORT[k]}</th>)}
        <th className="hide-sm">Trend</th>
        <th className="xl">Submitted by</th>
        <th>Scanned</th>
      </tr></thead>
      <tbody>
        {repos.map((r) => (
          <RepoRow key={r.name} repo={r} expanded={open.has(r.name)} onToggle={() => toggle(r.name)}
            onOpen={onOpen} onDelete={onDelete} activeJobs={activeJobs} />
        ))}
      </tbody>
    </table>
  );
}

export function RunTable({ subs, onOpen, onDelete, activeJobs }) {
  return (
    <table className="tbl">
      <thead><tr>
        <th>Repository / commit</th>
        <th className="hide-sm">Status</th>
        {COUNTED.map((k) => <th key={k} className="num">{SHORT[k]}</th>)}
        <th>Submitted</th>
        <th />
      </tr></thead>
      <tbody>
        {subs.map((s) => (
          <tr key={s.id} className="click" onClick={() => onOpen(s)}>
            <td>
              <div className="rname" style={{ cursor: "inherit" }}>{s.repo_full_name}</div>
              <div className="rmeta">
                <Ref sub={s} /><span className="mono">{s.commit_sha.slice(0, 7)}</span>
                <span>· {s.submitter || s.github_actor || "—"}</span>
              </div>
            </td>
            <td className="hide-sm"><RunStatus sub={s} llmActive={activeJobs.has(s.id)} /></td>
            <SevCells sub={s} />
            <td style={{ whiteSpace: "nowrap" }}>{ago(s.created_at)}</td>
            <td style={{ textAlign: "right", width: 120 }}>
              {onDelete && canDelete(s) && <ArmedButton onConfirm={() => onDelete(s)} />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Rail ─────────────────────────────────────────────────────────────────────

export function AttentionList({ subs, onOpen, admin }) {
  // Admins see analyst sign-offs waiting for their approval first.
  const approvals = admin ? subs.filter((s) => s.status === "awaiting_approval") : [];
  const items = [...approvals, ...subs.filter((s) => s.status === "needs_review")

    .sort((a, b) => (n(b, "critical") - n(a, "critical")) || (n(b, "high") - n(a, "high"))
      || (new Date(a.created_at) - new Date(b.created_at)))]
    .slice(0, 5);
  return (
    <section className="panel">
      <div className="panel-h"><h2>Needs your attention</h2><span className="aside">by severity, then age</span></div>
      {items.length === 0 && <div className="empty">Nothing waiting for review.</div>}
      {items.map((s) => {
        const bar = s.status === "awaiting_approval" ? "var(--low)" : n(s, "critical") ? "var(--crit-solid)" : n(s, "high") > 5 ? "var(--high-solid)" : "var(--accent)";
        return (
          <div key={s.id} className="att" onClick={() => onOpen(s)}>
            <div className="bar" style={{ background: bar }} />
            <div style={{ minWidth: 0 }}>
              <div className="t">{s.repo_full_name.split("/").pop()}</div>
              <div className="muted" style={{ fontSize: ".82rem" }}>
                <span className="mono">{refOf(s)}</span> · {s.status === "awaiting_approval"
                  ? <span style={{ color: "var(--low)" }}>signed off by analyst, awaiting your approval</span>
                  : <>waiting {since(s.created_at)}</>}
              </div>
              <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                {COUNTED.filter((k) => n(s, k)).map((k) => (
                  <span key={k} className="pill" style={{ color: `var(--${sevVar(k)})`, background: `var(--${sevVar(k)}-bg)` }}>
                    {n(s, k)} {SHORT[k].toUpperCase()}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

const DISPOSITION_WORDS = { false_positive: "false positive", confirmed: "confirmed", escalated: "escalated" };

function describe(e) {
  const repo = <b>{e.repo.split("/").pop()}</b>;
  const ref = e.ref ? ` (${e.ref})` : "";
  const findings = plural(e.count, "finding");
  switch (e.kind) {
    case "queued":   return ["var(--text3)", <>Queued {repo}{ref}</>];
    case "scanning": return ["var(--run)", <>Scan started on {repo}{ref}</>];
    case "ready":    return ["var(--med-solid)", <>{repo}{ref} ready for review</>];
    case "failed":   return ["var(--crit-solid)", <>{repo}{ref} scan failed{e.detail ? `: ${e.detail.slice(0, 80)}` : ""}</>];
    case "sign_off": return ["var(--ok)", <><b>{e.actor}</b> signed off {repo}{ref}</>];
    case "analyst_sign_off": return ["var(--low)", <><b>{e.actor}</b> signed off {repo}{ref} for approval</>];
    case "sign_off_returned": return ["var(--high)", <><b>{e.actor}</b> sent {repo}{ref} back for review</>];
    case "awaiting_approval": return ["var(--low)", <>{repo}{ref} awaiting approval</>];
    case "llm_rerun": return ["var(--text3)", <>LLM re-run on {repo}{ref}</>];
    default: {
      const word = DISPOSITION_WORDS[e.kind] || e.kind.replaceAll("_", " ");
      if (e.actor === "custos") return ["var(--text3)", <>Carried forward {findings} as {word} in {repo}</>];
      return ["var(--text3)", <><b>{e.actor}</b> marked {findings} {word} in {repo}</>];
    }
  }
}

export function ActivityFeed({ events, onOpen }) {
  return (
    <section className="panel">
      <div className="panel-h"><h2>Recent activity</h2></div>
      {events.length === 0 && <div className="empty">No activity yet.</div>}
      {events.map((e, i) => {
        const [color, text] = describe(e);
        return (
          <div key={i} className="ev" onClick={() => onOpen({ id: e.submission_id })}>
            <span className="dot" style={{ background: color }} />
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{text}</span>
            <time>{since(e.at)}</time>
          </div>
        );
      })}
    </section>
  );
}
