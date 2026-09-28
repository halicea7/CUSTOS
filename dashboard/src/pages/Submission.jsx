import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTheme } from "../App.jsx";
import { Severity, StatusBadge, SEV_ORDER, fmtDate, Btn, Pill } from "../components/atoms.jsx";
import ReportModal from "../components/submission/ReportModal.jsx";
import LlmRerunPanel from "../components/submission/LlmPanel.jsx";
import SummaryPanel from "../components/submission/SummaryPanel.jsx";
import FindingRow from "../components/submission/FindingRow.jsx";
import { useInvalidateSubmission, useSubmission, useSubmissionFindings } from "../api/queries.js";
import { errorMessage } from "../api/errors.js";

function MetaItem({ theme, label, children, mono }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: theme.c.text3, letterSpacing: "0.08em",
        textTransform: "uppercase", fontFamily: theme.fontMono }}>{label}</span>
      <span style={{ fontSize: 13, color: theme.c.text,
        fontFamily: mono ? theme.fontMono : theme.fontUi, fontWeight: 500 }}>{children}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Submission() {
  const { id }       = useParams();
  const navigate     = useNavigate();
  const { theme }    = useTheme();
  const [showReport, setShowReport] = useState(false);

  const subQuery = useSubmission(id);
  const sub = subQuery.data;
  const inFlight = !sub || sub.status === "pending" || sub.status === "analyzing";
  const findingsQuery = useSubmissionFindings(id, inFlight ? "analyzing" : sub.status);
  const findings = findingsQuery.data || [];
  const refresh = useInvalidateSubmission(id);

  const t = theme;
  const queryError = subQuery.error || findingsQuery.error;

  if (queryError) return (
    <div style={{ padding: 24 }}>
      <div style={{ padding: 16, background: `${t.sev.critical.fg}14`,
        border: `1px solid ${t.sev.critical.fg}33`, borderRadius: t.radiusLg,
        color: t.sev.critical.fg }}>{errorMessage(queryError, "Failed to load")}</div>
    </div>
  );
  if (!sub || (!inFlight && findingsQuery.isPending)) return (
    <div style={{ padding: 60, textAlign: "center", color: t.c.text3, fontSize: 12 }}>
      Loading submission…
    </div>
  );

  const grouped = SEV_ORDER.map(k => ({
    sev: k, items: findings.filter(f => f.severity === k),
  })).filter(g => g.items.length);

  return (
    <div>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${t.c.border}`, background: t.c.surface }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 34px 22px" }}>
          <button onClick={() => navigate("/")} style={{ display: "inline-flex", alignItems: "center",
            gap: 6, background: "none", border: "none", color: t.c.text2, cursor: "pointer",
            fontSize: 12, fontFamily: t.fontUi, padding: 0, marginBottom: 14 }}>
            ← Back to queue
          </button>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between",
            gap: 20, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 600, color: t.c.text,
                fontFamily: t.fontDisplay, letterSpacing: "-0.025em" }}>{sub.repo_full_name}</h1>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                <Pill theme={t}>{sub.commit_sha?.slice(0, 12)}</Pill>
                {sub.branch && (
                  <Pill theme={t} tone={t.c.link}>
                    {sub.pr_number ? `PR #${sub.pr_number} ` : ""}{sub.branch}
                  </Pill>
                )}
                {sub.event_type && <Pill theme={t}>{sub.event_type}</Pill>}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
              {sub.submitter && (
                <MetaItem theme={t} label="Submitter">{sub.submitter}</MetaItem>
              )}
              {sub.github_actor && sub.github_actor !== sub.submitter && (
                <MetaItem theme={t} label="Actor">{sub.github_actor}</MetaItem>
              )}
              <MetaItem theme={t} label="Submitted" mono>{fmtDate(sub.created_at)}</MetaItem>
              <StatusBadge theme={t} status={sub.status} size="lg" />
              <Btn theme={t} size="sm" onClick={() => setShowReport(true)}>↓ Report</Btn>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 34px" }}>
        {sub.error_message && (
          <div style={{ marginBottom: 18, padding: "12px 16px", borderRadius: t.radiusLg,
            background: `${t.sev.critical.fg}10`, border: `1px solid ${t.sev.critical.fg}33`,
            color: sub.status === "error" ? t.sev.critical.fg : t.c.text2, fontSize: 12.5,
            whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <strong style={{ color: t.sev.critical.fg }}>
              {sub.status === "error" ? "Analysis failed: " : "Note: "}
            </strong>
            {sub.error_message}
          </div>
        )}

        {/* LLM re-run */}
        {!inFlight && <LlmRerunPanel theme={t} submissionId={id} onComplete={refresh} />}

        {/* Two-column layout */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 26, alignItems: "start" }}>
          {/* Findings list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            {inFlight ? (
              <div style={{ padding: "50px 24px", textAlign: "center", color: t.c.text2,
                background: t.c.surface, border: `1px solid ${t.c.border}`, borderRadius: t.radiusLg }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: t.c.accent, marginBottom: 8 }}>
                  {sub.status === "pending" ? "Waiting for a worker" : "Analysis in progress"}
                </div>
                <div style={{ fontSize: 12.5 }}>
                  SAST tools and the local LLM are still scanning this commit.
                  Findings will appear here as they land.
                </div>
              </div>
            ) : grouped.length === 0 ? (
              <div style={{ padding: "50px 24px", textAlign: "center", color: t.c.text2,
                background: t.c.surface, border: `1px solid ${t.c.border}`, borderRadius: t.radiusLg }}>
                No findings — this commit is clean.
              </div>
            ) : grouped.map((g) => (
              <div key={g.sev}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <Severity theme={t} severity={g.sev} size="lg" />
                  <span style={{ fontSize: 12, color: t.c.text3, fontFamily: t.fontMono }}>
                    {g.items.length} finding{g.items.length !== 1 ? "s" : ""}
                  </span>
                  <div style={{ flex: 1, height: 1, background: t.c.border }} />
                </div>
                <div style={{ border: `1px solid ${t.c.border}`, borderRadius: t.radiusLg,
                  overflow: "hidden", background: t.c.surface }}>
                  {g.items.map((fd, i) => (
                    <FindingRow key={fd.id} theme={t} finding={fd} last={i === g.items.length - 1}
                      onOpen={(f) => navigate(`/findings/${f.id}`, {
                        state: { repoName: sub.repo_full_name, submissionId: sub.id }
                      })} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Sidebar */}
          {!inFlight && <SummaryPanel theme={t} sub={sub} findings={findings} />}
        </div>
      </div>

      {showReport && (
        <ReportModal theme={t} sub={sub} findings={findings} onClose={() => setShowReport(false)} />
      )}
    </div>
  );
}
