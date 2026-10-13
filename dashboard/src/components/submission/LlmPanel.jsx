// LLM re-run progress (above the findings) and run history (side column).
import React, { useState } from "react";
import { useLlmRuns } from "../../api/queries.js";
import { fmtDuration, fmtTokens } from "./report.js";

export const LLM_ACTIVE = new Set(["queued", "running"]);

export function LlmProgress({ status }) {
  if (!LLM_ACTIVE.has(status?.status)) return null;
  const queued = status.status === "queued";
  const pct = Math.round((status.progress || 0) * 100);
  const remaining = !queued && status.estimated > 0 ? Math.max(0, Math.round(status.estimated - status.elapsed)) : null;
  return (
    <div className="panel panel-b" style={{ marginBottom: "var(--gap)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8, fontSize: ".86rem" }}>
        <span><span className="spin" /> {queued ? "LLM re-run queued, waiting for a worker" : "LLM re-run in progress"}</span>
        <span className="mono muted">{queued ? "" : `${pct}%${remaining !== null ? ` · ~${remaining}s left` : ""}`}</span>
      </div>
      <div className="track"><span style={{ width: queued ? "6%" : `${pct}%`, background: "var(--grad)" }} /></div>
      <div className="muted" style={{ fontSize: ".8rem", marginTop: 8 }}>
        Re-clones the same commit. Only LLM findings are replaced; dismissals carry forward.
      </div>
    </div>
  );
}

const RUN_COLOR = { complete: "var(--ok)", failed: "var(--crit)" };

export function LlmRuns({ submissionId }) {
  const [open, setOpen] = useState(false);
  const { data: runs, isError } = useLlmRuns(submissionId, open);
  return (
    <section className="panel panel-b">
      <button className="link" style={{ fontWeight: 600, color: "var(--text)", display: "flex", gap: 8, alignItems: "center" }}
        onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="chev" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }}>›</span>
        LLM runs
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {isError && <div className="muted">Couldn&rsquo;t load the runs.</div>}
          {!runs && !isError && <div className="muted">Loading…</div>}
          {runs?.length === 0 && <div className="muted">No LLM runs recorded.</div>}
          {runs?.map((r) => (
            <div key={r.id} style={{ fontSize: ".82rem", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="dot" style={{ background: RUN_COLOR[r.status] || "var(--run)" }} />
                <b style={{ color: "var(--text)" }}>
                  {{ rerun: "Re-run", chains: "Attack chains" }[r.triggered_by] || "Initial"}</b>
                <span className="mono dim" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {r.model}
                </span>
              </div>
              <div className="muted" style={{ marginTop: 3 }}>
                {r.status === "complete" ? "done" : r.status} · {fmtDuration(r.duration_seconds)}
                {" "}· {r.findings_count ?? "—"} {r.triggered_by === "chains" ? "chains" : "findings"}
                {" "}· {fmtTokens(r.prompt_tokens)} in / {fmtTokens(r.completion_tokens)} out
              </div>
              {r.error && (
                <div className={r.status === "failed" ? "mono" : ""} style={{ marginTop: 4, color: r.status === "failed" ? "var(--crit)" : "var(--text3)",
                  whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: ".76rem" }}>{r.error}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
