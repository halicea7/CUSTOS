import React, { useEffect, useState } from "react";
import { Btn } from "../atoms.jsx";
import { useLlmRuns, useLlmStatus, useRerunLlm } from "../../api/queries.js";
import { errorMessage } from "../../api/errors.js";
import { fmtDuration, fmtTokens } from "./report.js";

function LlmRunHistory({ theme, submissionId }) {
  const [open, setOpen] = useState(false);
  const { data: runs = null, isError } = useLlmRuns(submissionId, open);
  const t = theme;

  const statusColor = s => s === "complete" ? t.status.signed_off[t.mode === "light" ? "light" : "dark"]
    : s === "failed" ? t.sev.critical.fg : t.c.accent;

  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: "none", border: "none", padding: 0,
        color: t.c.text3, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
        fontFamily: t.fontMono, letterSpacing: "0.06em" }}>
        <span style={{ fontSize: 9 }}>{open ? "▼" : "▶"}</span>
        LLM DETAILS
      </button>
      {open && (
        <div style={{ marginTop: 10, border: `1px solid ${t.c.border}`, borderRadius: t.radius, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 70px 70px 70px 70px 80px",
            padding: "6px 12px", background: t.c.raised, borderBottom: `1px solid ${t.c.border}`, gap: 8 }}>
            {["TRIGGER","MODEL","STATUS","DUR.","FINDS","TOK IN","TOK OUT"].map(h => (
              <span key={h} style={{ fontSize: 9, color: t.c.text3, letterSpacing: "0.08em", fontWeight: 600 }}>{h}</span>
            ))}
          </div>
          {isError && <div style={{ padding: 12, fontSize: 11, color: t.sev.critical.fg }}>Failed to load runs.</div>}
          {runs === null && !isError && <div style={{ padding: 12, fontSize: 11, color: t.c.text3 }}>Loading…</div>}
          {runs?.length === 0 && <div style={{ padding: 12, fontSize: 11, color: t.c.text3 }}>No runs recorded yet.</div>}
          {runs?.map((r, i) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "80px 1fr 70px 70px 70px 70px 80px",
              padding: "8px 12px", gap: 8, alignItems: "center",
              borderBottom: i < runs.length - 1 ? `1px solid ${t.c.border}` : "none",
              background: i % 2 === 0 ? t.c.surface : t.c.raised }}>
              <span style={{ fontSize: 10, fontWeight: 600, fontFamily: t.fontMono,
                color: r.triggered_by === "rerun" ? t.c.accent : t.c.text3 }}>
                {r.triggered_by === "rerun" ? "RE-RUN" : "INITIAL"}
              </span>
              <span style={{ fontSize: 11, color: t.c.text2, fontFamily: t.fontMono,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.model}</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: statusColor(r.status), fontFamily: t.fontMono }}>
                {r.status === "complete" ? "DONE" : r.status === "failed" ? "FAILED" : "RUNNING"}
              </span>
              <span style={{ fontSize: 11, color: t.c.text2, fontFamily: t.fontMono }}>{fmtDuration(r.duration_seconds)}</span>
              <span style={{ fontSize: 11, color: t.c.text2, fontFamily: t.fontMono }}>{r.findings_count ?? "—"}</span>
              <span style={{ fontSize: 11, color: t.c.text3, fontFamily: t.fontMono }}>{fmtTokens(r.prompt_tokens)}</span>
              <span style={{ fontSize: 11, color: t.c.text3, fontFamily: t.fontMono }}>{fmtTokens(r.completion_tokens)}</span>
              {r.error && (
                <span style={{ gridColumn: "1 / -1", fontSize: 11, color: r.status === "failed" ? t.sev.critical.fg : t.c.text3,
                  fontFamily: t.fontMono, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LlmRerunPanel({ theme, submissionId, onComplete }) {
  const { data: status, refetch } = useLlmStatus(submissionId);
  const rerun = useRerunLlm(submissionId);
  const [prevStatus, setPrevStatus] = useState(null);
  const t = theme;

  // Fire onComplete once when a run we watched transitions to complete/failed.
  useEffect(() => {
    const now = status?.status;
    if ((prevStatus === "running" || prevStatus === "queued") && (now === "complete" || now === "failed")) {
      onComplete?.();
    }
    setPrevStatus(now ?? null);
  }, [status?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRerun = () => rerun.mutate(undefined, { onSuccess: () => refetch() });
  const error = rerun.error
    ? errorMessage(rerun.error, "Failed to start re-run")
    : status?.status === "failed" ? "LLM re-run failed — see the run details below." : null;

  const isActive = status?.status === "running" || status?.status === "queued";
  const pct = Math.round((status?.progress || 0) * 100);
  const remaining = status?.status === "running" && status.estimated > 0
    ? Math.max(0, Math.round(status.estimated - status.elapsed)) : null;

  return (
    <div style={{ border: `1px solid ${t.c.border}`, borderRadius: t.radiusLg,
      overflow: "hidden", background: t.c.surface, marginBottom: 18 }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${t.c.border}`,
        background: t.c.raised, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: t.c.text2 }}>LLM ANALYSIS</span>
        {status?.status === "complete" && (
          <span style={{ fontSize: 10, color: t.status.signed_off[t.mode === "light" ? "light" : "dark"], fontWeight: 600 }}>✓ COMPLETE</span>
        )}
      </div>
      <div style={{ padding: "14px 16px" }}>
        {isActive ? (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: t.c.text2 }}>
                {status.status === "queued" ? "Queued…" : "Running…"}
              </span>
              <span style={{ fontSize: 11, color: t.c.text3, fontFamily: t.fontMono }}>
                {status.status === "running"
                  ? `${pct}%${remaining !== null ? ` · ~${remaining}s remaining` : ""}`
                  : "waiting for worker"}
              </span>
            </div>
            <div style={{ height: 4, background: t.c.border, borderRadius: 999, overflow: "hidden" }}>
              <div style={{ height: "100%", width: status.status === "queued" ? "6%" : `${pct}%`,
                background: t.c.accent, borderRadius: 999, transition: "width 1.8s ease-out",
                animation: status.status === "queued" ? "shimmer 1.4s ease-in-out infinite" : "none" }} />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Btn theme={t} variant="primary" size="sm" onClick={handleRerun} disabled={rerun.isPending}>
              {rerun.isPending ? "Starting…" : "↺ Re-run LLM"}
            </Btn>
            <span style={{ fontSize: 11, color: t.c.text3 }}>
              Re-clones at the same SHA · only LLM findings are replaced
            </span>
          </div>
        )}
        {status?.status === "complete" && (
          <div style={{ marginTop: 10, fontSize: 12,
            color: t.status.signed_off[t.mode === "light" ? "light" : "dark"] }}>
            ✓ Findings updated — scroll down to review new LLM results
          </div>
        )}
        {error && (
          <div style={{ marginTop: 8, padding: "8px 12px", background: `${t.sev.critical.fg}14`,
            border: `1px solid ${t.sev.critical.fg}33`, borderRadius: t.radius,
            color: t.sev.critical.fg, fontSize: 12 }}>{error}</div>
        )}
        <LlmRunHistory theme={t} submissionId={submissionId} />
      </div>
    </div>
  );
}
