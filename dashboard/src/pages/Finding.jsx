import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getFinding, getFindingAudit } from "../api/findings.js";
import SeverityBadge from "../components/SeverityBadge.jsx";
import CodeViewer from "../components/CodeViewer.jsx";
import DispositionPanel from "../components/DispositionPanel.jsx";

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

const SOURCE_COLORS = {
  semgrep:   { color: "#388bfd", label: "SEMGREP" },
  gitleaks:  { color: "#f85149", label: "GITLEAKS" },
  pip_audit: { color: "#d29922", label: "PIP-AUDIT" },
  npm_audit: { color: "#e3650a", label: "NPM-AUDIT" },
  llm:       { color: "#bc8cff", label: "LLM" },
};

function SourceTag({ source }) {
  const s = SOURCE_COLORS[source?.toLowerCase()] || { color: "#8b949e", label: source?.toUpperCase() || "UNKNOWN" };
  return (
    <span style={{
      padding: "2px 8px", borderRadius: "3px", fontSize: "10px", fontWeight: 600,
      letterSpacing: "0.08em", color: s.color, background: `${s.color}18`,
      border: `1px solid ${s.color}33`,
    }}>
      {s.label}
    </span>
  );
}

function Section({ title, children, collapsible = false, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: "var(--radius-lg)",
      overflow: "hidden", marginBottom: "16px",
    }}>
      <div
        onClick={() => collapsible && setOpen(o => !o)}
        style={{
          padding: "10px 16px",
          background: "var(--bg-3)",
          borderBottom: open ? "1px solid var(--border)" : "none",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: collapsible ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: "11px", color: "var(--text-2)", letterSpacing: "0.08em", fontWeight: 600 }}>
          {title}
        </span>
        {collapsible && (
          <span style={{ color: "var(--text-3)", fontSize: "12px", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0)" }}>
            ▾
          </span>
        )}
      </div>
      {open && (
        <div style={{ padding: "16px", background: "var(--bg-2)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function AuditLog({ findingId }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getFindingAudit(findingId)
      .then(setEntries)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [findingId]);

  const ACTION_COLORS = {
    confirmed:      "#f85149",
    false_positive: "#3fb950",
    escalated:      "#bc8cff",
    sign_off:       "#f0a500",
  };

  return (
    <Section title="AUDIT LOG">
      {loading ? (
        <span style={{ color: "var(--text-3)", fontSize: "12px" }}>Loading...</span>
      ) : entries.length === 0 ? (
        <span style={{ color: "var(--text-3)", fontSize: "12px" }}>No audit entries.</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {entries.map((e, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "auto 1fr auto",
              gap: "12px", alignItems: "start",
              padding: "8px 12px",
              background: "var(--bg-3)", border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}>
              <span style={{
                fontSize: "10px", fontWeight: 700, letterSpacing: "0.1em",
                color: ACTION_COLORS[e.action] || "var(--text-2)",
                background: `${ACTION_COLORS[e.action] || "#8b949e"}18`,
                border: `1px solid ${ACTION_COLORS[e.action] || "#8b949e"}33`,
                padding: "1px 6px", borderRadius: "3px", whiteSpace: "nowrap",
              }}>
                {e.action.toUpperCase().replace("_", " ")}
              </span>
              <div>
                <span style={{ color: "var(--text-2)", fontSize: "12px" }}>{e.analyst}</span>
                {e.note && (
                  <div style={{ color: "var(--text-3)", fontSize: "11px", marginTop: "3px" }}>
                    {e.note}
                  </div>
                )}
              </div>
              <span style={{ color: "var(--text-3)", fontSize: "11px", whiteSpace: "nowrap" }}>
                {fmtDate(e.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export default function Finding() {
  const { id } = useParams();
  const [finding, setFinding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getFinding(id)
      .then(setFinding)
      .catch(e => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <div style={{ padding: "60px", textAlign: "center", color: "var(--text-3)", fontSize: "12px" }}>
      Loading finding...
    </div>
  );
  if (error) return (
    <div style={{ padding: "24px" }}>
      <div style={{ padding: "16px", background: "var(--red-dim)", border: "1px solid #f8514933", borderRadius: "var(--radius-lg)", color: "var(--red)" }}>{error}</div>
    </div>
  );

  const extMap = {
    py: "python", js: "javascript", jsx: "javascript", ts: "typescript",
    tsx: "typescript", rb: "ruby", go: "go", java: "java", php: "php",
    sh: "bash", yaml: "yaml", yml: "yaml", json: "json", sql: "sql",
    c: "c", cpp: "cpp", cs: "csharp", rs: "rust",
  };
  const ext = finding.file_path?.split(".").pop()?.toLowerCase();
  const lang = extMap[ext] || "plaintext";

  return (
    <div style={{ padding: "24px", maxWidth: "1000px", margin: "0 auto" }}>
      {/* Breadcrumb */}
      <div style={{ marginBottom: "20px", display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--text-3)" }}>
        <Link to="/" style={{ color: "var(--text-3)", textDecoration: "none" }}>Queue</Link>
        <span>›</span>
        <Link to={`/submissions/${finding.submission_id}`} style={{ color: "var(--text-3)", textDecoration: "none" }}>Submission</Link>
        <span>›</span>
        <span style={{ color: "var(--text-2)" }}>Finding</span>
      </div>

      {/* Title block */}
      <div style={{
        background: "var(--bg-2)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", padding: "20px 24px", marginBottom: "20px",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
          <SeverityBadge severity={finding.severity} full />
          <SourceTag source={finding.source} />
          {finding.cwe && (
            <span style={{ fontSize: "11px", color: "var(--text-3)", padding: "2px 8px", border: "1px solid var(--border)", borderRadius: "3px" }}>
              {finding.cwe}
            </span>
          )}
        </div>
        <h1 style={{
          marginTop: "12px", fontSize: "17px", fontWeight: 600,
          color: "var(--text)", fontFamily: "var(--sans)", letterSpacing: "-0.01em",
          lineHeight: 1.4,
        }}>
          {finding.title}
        </h1>
        {finding.file_path && (
          <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
            {finding.file_path}
            {finding.line_start ? <span>:{finding.line_start}</span> : null}
            {finding.line_end && finding.line_end !== finding.line_start ? <span>–{finding.line_end}</span> : null}
          </div>
        )}
      </div>

      {/* Code viewer */}
      {finding.code_snippet && (
        <div style={{ marginBottom: "16px" }}>
          <CodeViewer
            code={finding.code_snippet}
            language={lang}
            lineStart={finding.line_start}
            lineEnd={finding.line_end}
            filePath={finding.file_path}
          />
        </div>
      )}

      {/* Description */}
      <Section title="DESCRIPTION">
        <p style={{ color: "var(--text)", fontSize: "13px", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
          {finding.description || "No description provided."}
        </p>
      </Section>

      {/* Remediation */}
      {finding.remediation && (
        <Section title="REMEDIATION">
          <p style={{ color: "var(--text)", fontSize: "13px", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {finding.remediation}
          </p>
        </Section>
      )}

      {/* LLM reasoning — collapsible */}
      {finding.llm_reasoning && (
        <Section title="LLM REASONING" collapsible defaultOpen={false}>
          <p style={{ color: "var(--text-2)", fontSize: "12px", lineHeight: 1.7, whiteSpace: "pre-wrap", fontStyle: "italic" }}>
            {finding.llm_reasoning}
          </p>
        </Section>
      )}

      {/* Disposition panel */}
      <div style={{ marginBottom: "16px" }}>
        <DispositionPanel finding={finding} onUpdate={setFinding} />
      </div>

      {/* Audit log */}
      <AuditLog findingId={finding.id} />
    </div>
  );
}
