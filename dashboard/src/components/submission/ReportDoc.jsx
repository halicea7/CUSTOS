// The downloadable security report: one document for HTML and PDF (browser print,
// landscape). Built from the app's own pieces (Markdown, severity and decision
// labels, chain paths) so it reads like Custos; rendered to static HTML.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../Markdown.jsx";
import { findingLoc, sourceLabel } from "./FindingDetail.jsx";
import { realCode } from "./report.js";

const SEVS = ["critical", "high", "medium", "low", "info"];
const SEV_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
const DISP = { false_positive: "False positive", confirmed: "Confirmed", escalated: "Escalated" };
const STATUS = { needs_review: "Needs review", awaiting_approval: "Awaiting approval", signed_off: "Signed off",
  analyzing: "Scanning", pending: "Pending", error: "Error" };
const STAGE = { analyst_sign_off: "Signed off for approval", sign_off: "Approved and signed off", sign_off_returned: "Sent back for review" };
const plural = (n, w) => `${n} ${w}${n !== 1 ? "s" : ""}`;
const fmt = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// Light Custos palette; "bw" swaps every colour for greys so paper prints use only black ink.
const CSS = `
:root { --text:#1b1a22; --text2:#4b4858; --text3:#7a7687; --line:#e3e1ea; --soft:#f6f5f9; --accent:#6d4aff;
  --crit:#c0262d; --crit-bg:#fdecec; --high:#c25a12; --high-bg:#fdf0e6; --med:#9a6c12; --med-bg:#fbf4e2;
  --low:#2563a8; --low-bg:#e9f1fb; --info:#5f6472; --info-bg:#eff0f3; --ok:#1d7a4c; --ok-bg:#e6f4ec; --code:#f6f5f9; }
.bw { --text:#000; --text2:#222; --text3:#555; --line:#bbb; --soft:#fff; --accent:#000;
  --crit:#000; --crit-bg:#fff; --high:#000; --high-bg:#fff; --med:#000; --med-bg:#fff;
  --low:#000; --low-bg:#fff; --info:#000; --info-bg:#fff; --ok:#000; --ok-bg:#fff; --code:#fff; }
* { box-sizing:border-box; }
html, body { margin:0; background:#fff; }
body { font:13px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--text);
  -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.doc { padding:22px 28px; }
.mono, code, pre { font-family:ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,Consolas,monospace; }
h1 { font-size:20px; margin:0; } h2 { font-size:14px; margin:22px 0 10px; padding-bottom:5px; border-bottom:2px solid var(--line); }
h2 .n { color:var(--text3); font-weight:500; margin-left:6px; }
.head { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; padding-bottom:14px; border-bottom:2px solid var(--accent); }
.brand { font-size:11px; font-weight:700; letter-spacing:.14em; color:var(--accent); margin-bottom:4px; }
.meta { display:flex; gap:18px; flex-wrap:wrap; font-size:12px; color:var(--text2); margin-top:6px; }
.meta b { color:var(--text); font-weight:600; }
.facts { display:grid; grid-template-columns:auto auto; gap:2px 14px; font-size:12px; color:var(--text2); text-align:right; white-space:nowrap; }
.facts b { color:var(--text); }
.tiles { display:grid; grid-template-columns:repeat(6, minmax(0,1fr)); gap:10px; margin-top:14px; }
.tile { border:1px solid var(--line); border-radius:8px; padding:8px 12px; }
.tile .k { font-size:11px; color:var(--text3); } .tile .v { font-size:22px; font-weight:700; line-height:1.2; }
.verdict { margin-top:12px; padding:9px 12px; border-left:4px solid var(--accent); background:var(--soft); font-size:13px; }
.pill { display:inline-block; font-size:11px; font-weight:700; padding:1px 8px; border-radius:99px; white-space:nowrap; border:1px solid currentColor; }
.tag { display:inline-block; font-size:11px; padding:0 6px; border-radius:4px; border:1px solid var(--line); color:var(--text2); white-space:nowrap; }
.sev-critical { color:var(--crit); background:var(--crit-bg); } .sev-high { color:var(--high); background:var(--high-bg); }
.sev-medium { color:var(--med); background:var(--med-bg); } .sev-low { color:var(--low); background:var(--low-bg); }
.sev-info { color:var(--info); background:var(--info-bg); }
.chains { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
.chain { border:1px solid var(--line); border-radius:8px; padding:10px 12px; break-inside:avoid; }
.chain .t { font-weight:600; margin:5px 0 4px; } .path { font-size:12px; }
.path .ref { font-family:inherit; border:1px solid var(--line); border-radius:4px; padding:0 5px; }
.small { font-size:12px; color:var(--text2); }
.group { margin:16px 0 6px; display:flex; align-items:center; gap:8px; font-weight:600; }
.f { border:1px solid var(--line); border-left:4px solid var(--sevc,var(--line)); border-radius:6px; padding:10px 14px; margin-bottom:8px;
  display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); gap:18px; }
.f.nocode { grid-template-columns:1fr; }
.f .top { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:4px; }
.f .title { font-weight:600; font-size:13.5px; width:100%; }
.f h4 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin:8px 0 2px; }
.md { display:flex; flex-direction:column; gap:5px; font-size:12.5px; overflow-wrap:anywhere; }
.md p { margin:0; } .md ul, .md ol { margin:0; padding-left:18px; }
.md-code { font-size:.9em; padding:0 4px; border-radius:3px; background:var(--code); border:1px solid var(--line); }
.md-pre { margin:0; padding:6px 8px; background:var(--code); border:1px solid var(--line); border-radius:5px; font-size:11.5px; white-space:pre-wrap; }
.codebox { border:1px solid var(--line); border-radius:6px; background:var(--code); font-size:11.5px; line-height:1.5; overflow:hidden; }
.codebox .file { padding:3px 8px; border-bottom:1px solid var(--line); color:var(--text3); font-size:11px; }
.codebox table { border-collapse:collapse; width:100%; } .codebox td { padding:0 8px; vertical-align:top; white-space:pre-wrap; overflow-wrap:anywhere; }
.codebox td.ln { color:var(--text3); text-align:right; width:1%; white-space:nowrap; border-right:1px solid var(--line); }
.codebox tr.hl td { background:var(--crit-bg); font-weight:600; } .bw .codebox tr.hl td { background:#fff; text-decoration:underline; }
table.list { border-collapse:collapse; width:100%; font-size:12px; } table.list th, table.list td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
table.list th { color:var(--text3); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
.note { white-space:pre-wrap; background:var(--soft); border-radius:5px; padding:4px 8px; margin-top:3px; }
.foot { margin-top:22px; padding-top:8px; border-top:1px solid var(--line); font-size:11px; color:var(--text3); display:flex; justify-content:space-between; }
@page { size: landscape; margin: 10mm; }
@media print { .doc { padding:0; } h2, .group, .f .top { break-after:avoid; }
  .f .top, .codebox, .chain, table.list tr { break-inside:avoid; } .md p, .md li { orphans:2; widows:2; } }
`;

function Sev({ s }) { return <span className={`pill sev-${s}`}>{SEV_LABEL[s] || s}</span>; }

function Code({ f }) {
  const code = realCode(f);
  if (!code) return null;
  const start = f.line_start || 1;
  const end = f.line_end || f.line_start;
  return (
    <div className="codebox mono">
      {f.file_path && <div className="file">{findingLoc(f)}</div>}
      <table><tbody>
        {code.replace(/\n$/, "").split("\n").map((line, i) => {
          const n = start + i;
          return (
            <tr key={i} className={f.line_start && n >= f.line_start && n <= (end || n) ? "hl" : ""}>
              <td className="ln">{n}</td><td>{line || " "}</td>
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

function Finding({ f, refOf, isNew, chainOf }) {
  const code = realCode(f);
  const chain = chainOf.get(f.id);
  return (
    <div className={`f ${code ? "" : "nocode"}`} style={{ "--sevc": `var(--${{ critical: "crit", high: "high", medium: "med", low: "low", info: "info" }[f.severity]})` }}>
      <div>
        <div className="top">
          <span className="mono small">{refOf.get(f.id)}</span><Sev s={f.severity} />
          <span className="tag">{sourceLabel(f.source)}</span>
          <span className="tag">{f.disposition ? DISP[f.disposition] : "Untriaged"}</span>
          {isNew(f) && <span className="tag">New</span>}
          {chain && <span className="tag">⛓ chain: {chain}</span>}
          {f.cwe && <span className="tag mono">{f.cwe}</span>}
          <div className="title">{f.title}</div>
          {f.file_path && <div className="mono small">{findingLoc(f)}</div>}
        </div>
        {f.description && <><h4>Problem</h4><Markdown text={f.description} /></>}
        {f.llm_reasoning && <><h4>Analysis</h4><Markdown text={f.llm_reasoning} /></>}
        {f.remediation && <><h4>Suggested fix</h4><Markdown text={f.remediation} /></>}
        {f.disposed_by && <div className="small" style={{ marginTop: 6 }}>Decided by {f.disposed_by} · {fmt(f.disposed_at)}</div>}
      </div>
      {code && <div><Code f={f} /></div>}
    </div>
  );
}

function ReportDoc({ sub, findings, chains, cmp, signoffs, runs }) {
  const refOf = new Map(findings.map((f, i) => [f.id, `F${i + 1}`]));
  const newIds = new Set(cmp?.previous ? cmp.new_finding_ids : []);
  const isNew = (f) => newIds.has(f.id);
  const live = chains.filter((c) => c.live);
  const chainOf = new Map();
  live.forEach((c) => c.steps.forEach((s) => { if (!chainOf.has(s.f.id)) chainOf.set(s.f.id, c.severity); }));
  const open = findings.filter((f) => f.disposition !== "false_positive");
  const dismissed = findings.filter((f) => f.disposition === "false_positive");
  const count = (s) => open.filter((f) => f.severity === s).length;
  const decided = findings.filter((f) => f.disposition).length;
  const approved = [...signoffs].reverse().find((s) => s.action === "sign_off");
  const analyst = [...signoffs].reverse().find((s) => s.action === "analyst_sign_off");
  const ref = sub.pr_number ? `PR #${sub.pr_number}${sub.branch ? ` · ${sub.branch}` : ""}` : sub.branch;
  const llmRun = runs.find((r) => r.triggered_by !== "chains");
  const chainRun = runs.find((r) => r.triggered_by === "chains");
  const verdict = [
    count("critical") || count("high")
      ? `${count("critical")} critical and ${count("high")} high finding${count("critical") + count("high") !== 1 ? "s" : ""} open (not dismissed)`
      : "No open critical or high findings",
    `${decided} of ${findings.length} decided`,
    live.length ? `${plural(live.length, "attack chain")}` : null,
    approved ? `approved by ${approved.by}` : analyst ? `signed off by ${analyst.by}, awaiting approval` : "not signed off",
  ].filter(Boolean).join(" · ");

  return (
    <div className="doc">
      <div className="head">
        <div>
          <div className="brand">CUSTOS · SECURITY REVIEW</div>
          <h1 className="mono">{sub.repo_full_name}</h1>
          <div className="meta">
            <span>Commit <b className="mono">{sub.commit_sha?.slice(0, 12)}</b></span>
            {ref && <span>Ref <b>{ref}</b></span>}
            <span>Status <b>{STATUS[sub.status] || sub.status}</b></span>
            <span>Scanned <b>{fmt(sub.created_at)}</b></span>
          </div>
        </div>
        <div className="facts">
          <span>Submitted by</span><b>{sub.submitter || sub.github_actor || "—"}</b>
          <span>Signed off by</span><b>{analyst?.by || approved?.by || "—"}</b>
          <span>Approved by</span><b>{approved?.by || "—"}</b>
          <span>Generated</span><b>{fmt(new Date())}</b>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><div className="k">Open critical</div><div className="v" style={{ color: count("critical") ? "var(--crit)" : undefined }}>{count("critical")}</div></div>
        <div className="tile"><div className="k">Open high</div><div className="v" style={{ color: count("high") ? "var(--high)" : undefined }}>{count("high")}</div></div>
        <div className="tile"><div className="k">Medium / low / info</div><div className="v">{count("medium")} / {count("low")} / {count("info")}</div></div>
        <div className="tile"><div className="k">Decided</div><div className="v">{decided} / {findings.length}</div></div>
        <div className="tile"><div className="k">Since last scan</div><div className="v">{cmp?.previous ? <>+{newIds.size} / −{cmp.fixed.length}</> : "first scan"}</div></div>
        <div className="tile"><div className="k">Attack chains</div><div className="v">{live.length}</div></div>
      </div>
      <div className="verdict">{verdict}.</div>

      {live.length > 0 && (
        <>
          <h2>Attack chains<span className="n">{live.length} · LLM estimate</span></h2>
          <div className="chains">
            {live.map((c) => {
              const brk = c.steps[Math.min(c.break_index, c.steps.length - 1)];
              return (
                <div key={c.id} className="chain">
                  <Sev s={c.severity} /> <span className="small">{c.confidence} confidence</span>
                  <div className="t">{c.title}</div>
                  <div className="path mono">{c.steps.map((s, i) => <React.Fragment key={i}>{i > 0 && " → "}<span className="ref">{s.ref}</span></React.Fragment>)}</div>
                  {brk?.f && <div className="small" style={{ marginTop: 4 }}>Break it: fix <b>{brk.ref}</b> · {brk.f.title}</div>}
                  {c.narrative && <div style={{ marginTop: 4 }}><Markdown text={c.narrative} /></div>}
                </div>
              );
            })}
          </div>
        </>
      )}

      <h2>Findings<span className="n">{open.length}{dismissed.length ? ` · ${dismissed.length} false positive(s) listed at the end` : ""}</span></h2>
      {open.length === 0 && <div className="small">No open findings.</div>}
      {SEVS.map((s) => {
        const group = open.filter((f) => f.severity === s);
        if (!group.length) return null;
        return (
          <React.Fragment key={s}>
            <div className="group"><Sev s={s} /><span className="small">{group.length}</span></div>
            {group.map((f) => <Finding key={f.id} f={f} refOf={refOf} isNew={isNew} chainOf={chainOf} />)}
          </React.Fragment>
        );
      })}

      {signoffs.length > 0 && (
        <>
          <h2>Sign-off record</h2>
          <table className="list"><thead><tr><th>When</th><th>Who</th><th>Stage</th><th>Comment</th></tr></thead><tbody>
            {signoffs.map((s, i) => (
              <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{fmt(s.at)}</td><td>{s.by}</td><td>{STAGE[s.action] || s.action}</td>
                <td>{s.note ? <div className="note">{s.note}</div> : <span className="small">—</span>}</td></tr>
            ))}
          </tbody></table>
        </>
      )}

      {dismissed.length > 0 && (
        <>
          <h2>False positives<span className="n">{dismissed.length}</span></h2>
          <table className="list"><thead><tr><th>Ref</th><th>Severity</th><th>Finding</th><th>Location</th><th>Tool</th><th>Decided by</th></tr></thead><tbody>
            {dismissed.map((f) => (
              <tr key={f.id}><td className="mono">{refOf.get(f.id)}</td><td><Sev s={f.severity} /></td><td>{f.title}</td>
                <td className="mono">{findingLoc(f) || "—"}</td><td>{sourceLabel(f.source)}</td><td>{f.disposed_by || "—"}</td></tr>
            ))}
          </tbody></table>
        </>
      )}

      <h2>How this review was done</h2>
      <table className="list"><tbody>
        <tr><th>Tools</th><td>{[...new Set(findings.map((f) => sourceLabel(f.source)))].join(", ") || "—"}</td></tr>
        <tr><th>AI review</th><td>{llmRun ? <>{llmRun.model} · {llmRun.status}{llmRun.findings_count != null ? ` · ${plural(llmRun.findings_count, "finding")}` : ""}</> : "not run"}</td></tr>
        <tr><th>AI checks</th><td>{llmRun?.error ? <div className="note">{llmRun.error}</div> : <span className="small">No AI findings were dropped or lowered.</span>}</td></tr>
        {chainRun && <tr><th>Attack chains</th><td>{chainRun.model} · {plural(chainRun.findings_count || 0, "chain")}{chainRun.error ? <div className="note">{chainRun.error}</div> : null}</td></tr>}
      </tbody></table>

      <div className="foot"><span>Custos · {sub.repo_full_name} @ {sub.commit_sha?.slice(0, 12)}</span><span>Generated {fmt(new Date())}</span></div>
    </div>
  );
}

/** The full HTML file. *bw*: black and white, for paper. */
export function reportHtml(data, { bw = false } = {}) {
  const body = renderToStaticMarkup(<ReportDoc {...data} />);
  const title = `Security report · ${data.sub.repo_full_name} @ ${data.sub.commit_sha?.slice(0, 8)}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title.replace(/[<&]/g, "")}</title><style>${CSS}</style></head><body class="${bw ? "bw" : ""}">${body}</body></html>`;
}
