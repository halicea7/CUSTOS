// Queue page pieces: summary strip, repository table, run table and the
// right-hand rail (needs attention, recent activity).
import React, { useState } from "react";
import { StatusBadge } from "../atoms.jsx";
import { errorMessage } from "../../api/errors.js";

const COUNTED = ["critical", "high", "medium", "low"];
const IN_PROGRESS = new Set(["pending", "analyzing"]);
const DONE = new Set(["needs_review", "signed_off"]);

export const total = (s) => COUNTED.reduce((a, k) => a + (s.finding_counts?.[k] || 0), 0);
const n = (s, k) => s.finding_counts?.[k] || 0;
export const refOf = (s) => (s.pr_number ? `PR #${s.pr_number}` : s.branch || "—");

export function ago(ts) {
  if (!ts) return "—";
  const sec = (Date.now() - new Date(ts)) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Group runs by repo, newest first within each; repos ordered by latest run. */
export function groupByRepo(subs) {
  const map = new Map();
  [...subs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).forEach((s) => {
    if (!map.has(s.repo_full_name)) map.set(s.repo_full_name, []);
    map.get(s.repo_full_name).push(s);
  });
  return [...map.entries()].map(([name, runs]) => ({ name, runs, latest: runs[0] }));
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Panel({ theme: t, title, right, children, style }) {
  return (
    <section style={{ background: t.c.surface, border: `1px solid ${t.c.border}`, borderRadius: 12,
      boxShadow: t.c.shadow, overflow: "hidden", ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          flexWrap: "wrap", padding: "12px 16px", borderBottom: `1px solid ${t.c.border}` }}>
          {typeof title === "string"
            ? <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: t.c.text }}>{title}</h2>
            : title}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Dot({ color, pulse }) {
  return <span style={{ width: 7, height: 7, borderRadius: 99, background: color, display: "inline-block",
    flexShrink: 0, animation: pulse ? "custosPulse 1.3s ease-in-out infinite" : "none" }} />;
}

/** A severity count: coloured only when non-zero; zero is a faint dot. */
function SevNum({ theme: t, sev, value }) {
  if (!value) return <span style={{ color: t.c.border2, fontFamily: t.fontMono }}>·</span>;
  const s = t.sev[sev];
  return (
    <span style={{ fontFamily: t.fontMono, fontWeight: 600, fontSize: 13, color: s.fg,
      ...(sev === "critical" && { display: "inline-flex", minWidth: 26, justifyContent: "center",
        padding: "1px 7px", borderRadius: 6, background: s.bg }) }}>{value}</span>
  );
}

function Trend({ theme: t, runs }) {
  // Oldest → newest totals of finished runs.
  const vals = runs.filter((r) => DONE.has(r.status)).slice(0, 6).reverse().map(total);
  if (vals.length < 2) return <span style={{ color: t.c.text3, fontSize: 12 }}>—</span>;
  const mx = Math.max(...vals, 1);
  return (
    <div title={`Findings over the last ${vals.length} runs: ${vals.join(" → ")}`}
      style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 22, width: 72 }}>
      {vals.map((v, i) => (
        <span key={i} style={{ flex: 1, borderRadius: 2, height: `${Math.max(8, (v / mx) * 100)}%`,
          background: i === vals.length - 1 ? t.c.text3 : t.c.border2 }} />
      ))}
    </div>
  );
}

function MiniBar({ theme: t, sub }) {
  const tot = total(sub);
  return (
    <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: t.c.raised2 }}>
      {tot > 0 && COUNTED.map((k) => n(sub, k) > 0 && (
        <span key={k} style={{ width: `${(n(sub, k) / tot) * 100}%`, background: t.sev[k].solid, opacity: 0.85 }} />
      ))}
    </div>
  );
}

const Mono = ({ theme: t, children, style }) => (
  <span style={{ fontFamily: t.fontMono, fontSize: 12, ...style }}>{children}</span>
);

function Ref({ theme: t, sub }) {
  return (
    <span style={{ fontFamily: t.fontMono, fontSize: 11, padding: "1px 6px", borderRadius: 5,
      background: t.c.raised2, color: t.c.text2, whiteSpace: "nowrap" }}>{refOf(sub)}</span>
  );
}

// Admin-only "Delete" with an inline confirm. Clicks don't open the run.
function DeleteControl({ theme: t, sub, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const [busy,       setBusy]       = useState(false);
  const [err,        setErr]        = useState("");
  if (!onDelete || IN_PROGRESS.has(sub.status)) return null;
  const link = { background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12, fontFamily: t.fontUi };
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const remove = async () => {
    setBusy(true); setErr("");
    try { await onDelete(sub); }
    catch (e) { setErr(errorMessage(e, "Delete failed")); setConfirming(false); }
    finally { setBusy(false); }
  };
  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {err && <span style={{ fontSize: 11, color: t.sev.critical.fg }}>{err}</span>}
      {confirming ? (
        <>
          <button disabled={busy} onClick={stop(remove)}
            style={{ ...link, color: t.sev.critical.fg, fontWeight: 600 }}>{busy ? "Deleting…" : "Delete run"}</button>
          <button onClick={stop(() => setConfirming(false))} style={{ ...link, color: t.c.text3 }}>Cancel</button>
        </>
      ) : (
        <button title="Delete this run and its findings" onClick={stop(() => setConfirming(true))}
          style={{ ...link, color: t.c.text3 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = t.sev.critical.fg)}
          onMouseLeave={(e) => (e.currentTarget.style.color = t.c.text3)}>Delete</button>
      )}
    </span>
  );
}

function RunStatus({ theme: t, sub, llmActive }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <StatusBadge theme={t} status={sub.status} size="lg" />
      {llmActive && <span style={{ fontSize: 11, color: t.c.accent }}>LLM re-run…</span>}
    </span>
  );
}

// ── Summary strip ────────────────────────────────────────────────────────────

function Tile({ theme: t, dot, pulse, label, value, valueColor, hint, hintColor }) {
  return (
    <div style={{ background: t.c.surface, border: `1px solid ${t.c.border}`, borderRadius: 12,
      padding: "14px 16px", boxShadow: t.c.shadow, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: t.c.text2, display: "flex", alignItems: "center", gap: 7 }}>
        <Dot color={dot} pulse={pulse} />{label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4, letterSpacing: "-0.02em",
        color: valueColor || t.c.text, fontFamily: t.fontDisplay }}>{value}</div>
      <div style={{ fontSize: 12, color: hintColor || t.c.text3, marginTop: 2, whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis" }}>{hint}</div>
    </div>
  );
}

const DAY = 86400000;
const OLD_AFTER = 2 * DAY;  // waiting longer than this is called out

function ScanChart({ theme: t, subs }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => ({ start: today.getTime() - (13 - i) * DAY, runs: 0, crit: 0 }));
  let errors = 0, inRange = 0;
  subs.forEach((s) => {
    const d = days.find((x) => { const ts = new Date(s.created_at).getTime(); return ts >= x.start && ts < x.start + DAY; });
    if (!d) return;
    d.runs++; inRange++;
    if (n(s, "critical")) d.crit++;
    if (s.status === "error") errors++;
  });
  const mx = Math.max(...days.map((d) => d.runs), 1);
  return (
    <div className="q-wide" style={{ background: t.c.surface, border: `1px solid ${t.c.border}`, borderRadius: 12,
      padding: "14px 16px", boxShadow: t.c.shadow, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: t.c.text2 }}>Scans · last 14 days</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 46, marginTop: 8 }}>
        {days.map((d) => (
          <div key={d.start} title={`${new Date(d.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${d.runs} run${d.runs !== 1 ? "s" : ""}${d.crit ? `, ${d.crit} with critical` : ""}`}
            style={{ flex: 1, height: `${d.runs ? Math.max(8, (d.runs / mx) * 100) : 4}%`, borderRadius: "3px 3px 0 0",
              background: d.runs ? t.c.border2 : t.c.raised2, position: "relative", overflow: "hidden" }}>
            {d.crit > 0 && <i style={{ position: "absolute", left: 0, right: 0, bottom: 0,
              height: `${(d.crit / d.runs) * 100}%`, background: t.sev.critical.solid, opacity: 0.75 }} />}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 11.5, color: t.c.text3, marginTop: 6 }}>
        <span>▮ runs</span><span style={{ color: t.sev.critical.fg }}>▮ with critical</span>
        <span style={{ marginLeft: "auto" }}>{inRange} run{inRange !== 1 ? "s" : ""} · {errors} error{errors !== 1 ? "s" : ""}</span>
      </div>
    </div>
  );
}

export function SummaryStrip({ theme: t, subs, repos }) {
  const waiting = subs.filter((s) => s.status === "needs_review");
  const oldest = waiting.reduce((m, s) => Math.min(m, new Date(s.created_at).getTime()), Infinity);
  // Open findings: each repo's latest run that's still awaiting review.
  const open = repos.map((r) => r.latest).filter((s) => s.status === "needs_review");
  const crit = open.reduce((a, s) => a + n(s, "critical"), 0);
  const high = open.reduce((a, s) => a + n(s, "high"), 0);
  const critRepos = open.filter((s) => n(s, "critical")).length;
  const highRepos = open.filter((s) => n(s, "high")).length;
  const scanning = subs.filter((s) => s.status === "analyzing");
  const queued = subs.filter((s) => s.status === "pending").length;
  const plural = (k, w) => `${k} ${w}${k !== 1 ? "s" : ""}`;
  return (
    <div className="q-strip">
      <Tile theme={t} dot={t.sev.medium.solid} label="Needs review" value={waiting.length}
        hint={waiting.length ? `oldest ${ago(oldest).replace(" ago", "")}` : "all caught up"}
        hintColor={waiting.length && Date.now() - oldest > OLD_AFTER ? t.sev.high.fg : undefined} />
      <Tile theme={t} dot={t.sev.critical.solid} label="Open critical" value={crit}
        valueColor={crit ? t.sev.critical.fg : undefined} hint={crit ? `across ${plural(critRepos, "repo")}` : "none open"} />
      <Tile theme={t} dot={t.sev.high.solid} label="Open high" value={high}
        hint={high ? `across ${plural(highRepos, "repo")}` : "none open"} />
      <Tile theme={t} dot={t.status.analyzing[t.mode === "light" ? "light" : "dark"]} pulse={scanning.length > 0}
        label="Scanning now" value={scanning.length}
        hint={scanning.length ? `${scanning[0].repo_full_name.split("/").pop()} · ${ago(scanning[0].updated_at).replace(" ago", "")} in`
          : queued ? `${queued} queued` : "idle"} />
      <ScanChart theme={t} subs={subs} />
    </div>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

const th = (t, extra) => ({ textAlign: "left", fontSize: 11, fontWeight: 600, color: t.c.text3,
  textTransform: "uppercase", letterSpacing: "0.06em", padding: "9px 12px", background: t.c.raised,
  borderBottom: `1px solid ${t.c.border}`, whiteSpace: "nowrap", ...extra });
const td = (t, extra) => ({ padding: 12, borderBottom: `1px solid ${t.c.border}`, verticalAlign: "middle",
  fontSize: 13, color: t.c.text2, ...extra });
const NUM = { textAlign: "right", width: 52 };
const SEV_COLS = [["critical", "Crit"], ["high", "High"], ["medium", "Med"], ["low", "Low"]];

function RepoRow({ theme: t, repo, expanded, onToggle, onOpen, onDelete, activeJobs }) {
  const [hov, setHov] = useState(false);
  const s = repo.latest;
  const many = repo.runs.length > 1;
  const waitingLong = s.status === "needs_review" && Date.now() - new Date(s.created_at) > OLD_AFTER;
  const bg = hov ? t.c.raised : "transparent";
  return (
    <>
      <tr onClick={() => (many ? onToggle() : onOpen(s))} style={{ cursor: "pointer" }}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
        <td style={td(t, { paddingLeft: 16, background: bg })}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
            <span style={{ color: t.c.text3, width: 12, flexShrink: 0, display: "inline-block",
              transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "none" }}>{many ? "›" : ""}</span>
            <div style={{ minWidth: 0 }}>
              <button onClick={(e) => { e.stopPropagation(); onOpen(s); }} title="Open the latest run"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit",
                  fontWeight: 600, color: t.c.text, textAlign: "left" }}>{repo.name}</button>
              <div style={{ fontSize: 12, color: t.c.text3, marginTop: 2, display: "flex", gap: 6,
                alignItems: "center", flexWrap: "wrap" }}>
                <Ref theme={t} sub={s} /><Mono theme={t}>{s.commit_sha.slice(0, 7)}</Mono>
                <span>· {s.submitter || s.github_actor || "—"}</span>
                {many && <span>· {repo.runs.length} runs</span>}
                {s.status === "error" && s.error_message && (
                  <span title={s.error_message} style={{ color: t.sev.critical.fg, maxWidth: 360, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {s.error_message}</span>
                )}
              </div>
            </div>
          </div>
        </td>
        <td className="q-hide-sm" style={td(t, { background: bg })}><RunStatus theme={t} sub={s} llmActive={activeJobs.has(s.id)} /></td>
        {SEV_COLS.map(([k]) => (
          <td key={k} style={td(t, { ...NUM, background: bg })}>
            {IN_PROGRESS.has(s.status) || s.status === "error" ? "" : <SevNum theme={t} sev={k} value={n(s, k)} />}
          </td>
        ))}
        <td className="q-hide-sm" style={td(t, { background: bg })}><Trend theme={t} runs={repo.runs} /></td>
        <td style={td(t, { background: bg, whiteSpace: "nowrap", color: waitingLong ? t.sev.high.fg : t.c.text2 })}>
          {ago(s.created_at)}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ background: t.c.raised, padding: "4px 16px 10px 40px", borderBottom: `1px solid ${t.c.border}` }}>
            {repo.runs.map((r, i) => (
              <div key={r.id} onClick={() => onOpen(r)} className="q-hist"
                style={{ cursor: "pointer", borderBottom: i < repo.runs.length - 1 ? `1px dashed ${t.c.border}` : "none" }}>
                <Mono theme={t} style={{ color: t.c.text2 }}>{r.commit_sha.slice(0, 7)}</Mono>
                <span><Ref theme={t} sub={r} /></span>
                <RunStatus theme={t} sub={r} llmActive={activeJobs.has(r.id)} />
                {DONE.has(r.status) ? <MiniBar theme={t} sub={r} /> : <span />}
                <span style={{ fontSize: 12.5 }}>{ago(r.created_at)}</span>
                <span style={{ justifySelf: "end" }}><DeleteControl theme={t} sub={r} onDelete={onDelete} /></span>
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

export function RepoTable({ theme: t, repos, onOpen, onDelete, activeJobs }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (name) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>
        <th style={th(t, { paddingLeft: 36 })}>Repository</th>
        <th className="q-hide-sm" style={th(t)}>Latest run</th>
        {SEV_COLS.map(([k, l]) => <th key={k} title={t.sev[k].label} style={th(t, NUM)}>{l}</th>)}
        <th className="q-hide-sm" style={th(t)}>Trend</th>
        <th style={th(t)}>Scanned</th>
      </tr></thead>
      <tbody>
        {repos.map((r) => (
          <RepoRow key={r.name} theme={t} repo={r} expanded={open.has(r.name)} onToggle={() => toggle(r.name)}
            onOpen={onOpen} onDelete={onDelete} activeJobs={activeJobs} />
        ))}
      </tbody>
    </table>
  );
}

function RunRow({ theme: t, sub, onOpen, onDelete, llmActive }) {
  const [hov, setHov] = useState(false);
  const bg = hov ? t.c.raised : "transparent";
  return (
    <tr onClick={() => onOpen(sub)} style={{ cursor: "pointer" }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      <td style={td(t, { paddingLeft: 16, background: bg })}>
        <div style={{ fontWeight: 600, color: t.c.text }}>{sub.repo_full_name}</div>
        <div style={{ fontSize: 12, color: t.c.text3, marginTop: 2, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Ref theme={t} sub={sub} /><Mono theme={t}>{sub.commit_sha.slice(0, 7)}</Mono>
          <span>· {sub.submitter || sub.github_actor || "—"}</span>
        </div>
      </td>
      <td className="q-hide-sm" style={td(t, { background: bg })}><RunStatus theme={t} sub={sub} llmActive={llmActive} /></td>
      {SEV_COLS.map(([k]) => (
        <td key={k} style={td(t, { ...NUM, background: bg })}>
          {IN_PROGRESS.has(sub.status) || sub.status === "error" ? "" : <SevNum theme={t} sev={k} value={n(sub, k)} />}
        </td>
      ))}
      <td style={td(t, { background: bg, whiteSpace: "nowrap" })}>{ago(sub.created_at)}</td>
      <td style={td(t, { background: bg, textAlign: "right", width: 110 })}><DeleteControl theme={t} sub={sub} onDelete={onDelete} /></td>
    </tr>
  );
}

export function RunTable({ theme: t, subs, onOpen, onDelete, activeJobs }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>
        <th style={th(t, { paddingLeft: 16 })}>Repository / commit</th>
        <th className="q-hide-sm" style={th(t)}>Status</th>
        {SEV_COLS.map(([k, l]) => <th key={k} title={t.sev[k].label} style={th(t, NUM)}>{l}</th>)}
        <th style={th(t)}>Submitted</th>
        <th style={th(t)} />
      </tr></thead>
      <tbody>
        {subs.map((s) => (
          <RunRow key={s.id} theme={t} sub={s} onOpen={onOpen} onDelete={onDelete} llmActive={activeJobs.has(s.id)} />
        ))}
      </tbody>
    </table>
  );
}

// ── Rail ─────────────────────────────────────────────────────────────────────

export function AttentionList({ theme: t, subs, onOpen }) {
  const items = subs.filter((s) => s.status === "needs_review")
    .sort((a, b) => (n(b, "critical") - n(a, "critical")) || (n(b, "high") - n(a, "high"))
      || (new Date(a.created_at) - new Date(b.created_at)))
    .slice(0, 5);
  return (
    <Panel theme={t} title="Needs your attention" right={<span style={{ fontSize: 12, color: t.c.text3 }}>by severity, then age</span>}>
      {items.length === 0 && <div style={{ padding: "18px 16px", fontSize: 13, color: t.c.text3 }}>Nothing waiting for review.</div>}
      {items.map((s, i) => {
        const bar = n(s, "critical") ? t.sev.critical.solid : n(s, "high") > 5 ? t.sev.high.solid : t.sev.medium.solid;
        return (
          <div key={s.id} onClick={() => onOpen(s)} style={{ display: "flex", gap: 12, padding: "12px 16px", cursor: "pointer",
            borderBottom: i < items.length - 1 ? `1px solid ${t.c.border}` : "none" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = t.c.raised)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
            <div style={{ width: 3, borderRadius: 3, background: bar, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: t.c.text, overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap" }}>{s.repo_full_name.split("/").pop()}</div>
              <div style={{ fontSize: 12, color: t.c.text3 }}>
                <Mono theme={t} style={{ fontSize: 11.5 }}>{refOf(s)}</Mono> · waiting {ago(s.created_at).replace(" ago", "")}
              </div>
              <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                {COUNTED.filter((k) => n(s, k)).map((k) => (
                  <span key={k} style={{ fontFamily: t.fontMono, fontSize: 11, padding: "1px 6px", borderRadius: 5,
                    color: t.sev[k].fg, background: t.sev[k].bg }}>{n(s, k)} {t.sev[k].short}</span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

const DISPOSITION_WORDS = { false_positive: "false positive", confirmed: "confirmed", escalated: "escalated" };

function describe(t, e) {
  const B = ({ children }) => <b style={{ color: t.c.text, fontWeight: 600 }}>{children}</b>;
  const repo = <B>{e.repo.split("/").pop()}</B>;
  const ref = e.ref ? ` (${e.ref})` : "";
  const findings = `${e.count} finding${e.count !== 1 ? "s" : ""}`;
  switch (e.kind) {
    case "queued":   return [t.c.text3, <>Queued {repo}{ref}</>];
    case "scanning": return [t.status.analyzing[t.mode === "light" ? "light" : "dark"], <>Scan started on {repo}{ref}</>];
    case "ready":    return [t.sev.medium.solid, <>{repo}{ref} ready for review</>];
    case "failed":   return [t.sev.critical.solid, <>{repo}{ref} scan failed{e.detail ? `: ${e.detail.slice(0, 80)}` : ""}</>];
    case "sign_off": return [t.status.signed_off[t.mode === "light" ? "light" : "dark"], <><B>{e.actor}</B> signed off {repo}{ref}</>];
    default: {
      const word = DISPOSITION_WORDS[e.kind] || e.kind.replaceAll("_", " ");
      if (e.actor === "custos") return [t.c.text3, <>Carried forward {findings} as {word} in {repo}</>];
      return [t.c.text3, <><B>{e.actor}</B> marked {findings} {word} in {repo}</>];
    }
  }
}

export function ActivityFeed({ theme: t, events, onOpen }) {
  return (
    <Panel theme={t} title="Recent activity">
      <div style={{ padding: "4px 16px 8px" }}>
        {events.length === 0 && <div style={{ padding: "12px 0", fontSize: 13, color: t.c.text3 }}>No activity yet.</div>}
        {events.map((e, i) => {
          const [color, text] = describe(t, e);
          return (
            <div key={i} onClick={() => onOpen({ id: e.submission_id })} style={{ display: "grid",
              gridTemplateColumns: "14px 1fr auto", gap: 10, padding: "8px 0", fontSize: 12.5, color: t.c.text2,
              cursor: "pointer", borderBottom: i < events.length - 1 ? `1px solid ${t.c.border}` : "none" }}>
              <span style={{ marginTop: 6 }}><Dot color={color} /></span>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{text}</span>
              <span style={{ color: t.c.text3, fontSize: 11.5, whiteSpace: "nowrap" }}>{ago(e.at).replace(" ago", "")}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export { Panel };
