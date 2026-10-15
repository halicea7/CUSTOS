// Finding pieces shared by the run page's drawer and the /findings/:id page.
import React from "react";
import CodeViewer from "../CodeViewer.jsx";
import Markdown from "../Markdown.jsx";
import { useFindingAudit } from "../../api/queries.js";
import { sevVar } from "../queue/Board.jsx";
import { realCode } from "./report.js";

export const SEV_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

export const DISPOSITIONS = [
  { key: "false_positive", label: "False positive", cls: "fp", hotkey: "F" },
  { key: "confirmed",      label: "Confirm",        cls: "cf", hotkey: "C" },
  { key: "escalated",      label: "Escalate",       cls: "es", hotkey: "E" },
];
const DISP_TAG = {
  false_positive: ["False positive", "var(--ok)", "var(--ok-bg)"],
  confirmed:      ["Confirmed", "var(--crit)", "var(--crit-bg)"],
  escalated:      ["Escalated", "var(--accent)", "var(--accent-bg)"],
};

const SOURCE_LABEL = { npm_audit: "npm", pip_audit: "pip", osv: "OSV", sentinelone: "SentinelOne", llm: "LLM" };
export const sourceLabel = (s) => SOURCE_LABEL[s] || s;

const EXT_LANG = {
  py: "python", js: "javascript", jsx: "javascript", ts: "typescript",
  tsx: "typescript", rb: "ruby", go: "go", java: "java", php: "php",
  sh: "bash", yaml: "yaml", yml: "yaml", json: "json", sql: "sql",
  c: "c", cpp: "cpp", cs: "csharp", rs: "rust",
};

export const findingLoc = (f) => (f.file_path ? `${f.file_path}${f.line_start ? `:${f.line_start}` : ""}` : "");

export function SevPill({ sev }) {
  const k = sevVar(sev);
  return (
    <span className="sevpill" style={{ color: `var(--${k})`, background: `var(--${k}-bg)` }}>
      <span className="dot" style={{ background: `var(--${k})` }} />{SEV_LABEL[sev] || sev}
    </span>
  );
}

export function DispTag({ disposition }) {
  if (!disposition) return <span className="mono muted" style={{ fontSize: ".75rem" }}>untriaged</span>;
  const [label, color, bg] = DISP_TAG[disposition] || [disposition, "var(--text2)", "var(--raised2)"];
  return <span className="disp" style={{ color, background: bg }}>{label}</span>;
}

function fmtTs(ts) {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function History({ findingId }) {
  const { data: entries, isPending, isError } = useFindingAudit(findingId);
  if (isPending) return <div className="muted">Loading…</div>;
  if (isError) return <div className="muted">Couldn&rsquo;t load the history.</div>;
  if (!entries.length) return <div className="muted">No decisions yet.</div>;
  return entries.map((e, i) => (
    <div key={i} className="audit-row">
      <span className="dot" style={{ background: DISP_TAG[e.action]?.[1] || "var(--accent)", alignSelf: "center" }} />
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <b style={{ color: "var(--text)" }}>{e.analyst}</b> → {DISP_TAG[e.action]?.[0] || e.action.replaceAll("_", " ")}
        {e.note && <> · &ldquo;{e.note}&rdquo;</>}
      </span>
      <span className="muted" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{fmtTs(e.created_at)}</span>
    </div>
  ));
}

/** Code, explanation, fix and decision history for one finding. */
export function FindingBody({ finding: f }) {
  const lang = EXT_LANG[f.file_path?.split(".").pop()?.toLowerCase()] || "plaintext";
  return (
    <>
      {realCode(f) && (
        <CodeViewer code={realCode(f)} language={lang} lineStart={f.line_start}
          lineEnd={f.line_end} filePath={f.file_path} />
      )}
      {f.description && <div><h3>Description</h3><Markdown text={f.description} /></div>}
      {f.llm_reasoning && <div><h3>LLM analysis</h3><Markdown text={f.llm_reasoning} /></div>}
      {f.remediation && <div><h3>Suggested fix</h3><Markdown text={f.remediation} /></div>}
      {!realCode(f) && !f.description && !f.llm_reasoning && !f.remediation && (
        <p className="muted">The tool reported no further detail for this finding.</p>
      )}
      <div><h3>History</h3><History findingId={f.id} /></div>
    </>
  );
}

/** The F / C / E buttons. */
export function DecisionButtons({ current, onDecide, disabled }) {
  return DISPOSITIONS.map((d) => (
    <button key={d.key} className={`dbtn ${d.cls} ${current === d.key ? "on" : ""}`}
      disabled={disabled} onClick={() => onDecide(d.key)}>
      <span className="kbd">{d.hotkey}</span> {d.label}
    </button>
  ));
}
