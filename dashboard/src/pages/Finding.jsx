import React, { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { getFinding, getFindingAudit, setDisposition } from "../api/findings.js";
import { useTheme } from "../App.jsx";
import { Severity, DispositionTag, Btn, Label, fmtDate } from "../components/atoms.jsx";
import CodeViewer from "../components/CodeViewer.jsx";

function fmtTs(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Info block ────────────────────────────────────────────────────────────────

function InfoBlock({ theme, title, accent, children }) {
  const t = theme;
  return (
    <div style={{ background: t.c.surface, border: `1px solid ${t.c.border}`,
      borderRadius: t.radiusLg, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 16px",
        borderBottom: `1px solid ${t.c.border}`, background: t.c.raised }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: accent || t.c.accent }} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
          color: t.c.text2, fontFamily: t.fontMono }}>{title}</span>
      </div>
      <div style={{ padding: "16px 18px" }}>{children}</div>
    </div>
  );
}

// ── Audit log ─────────────────────────────────────────────────────────────────

function AuditLog({ theme, findingId }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const t = theme;

  useEffect(() => {
    getFindingAudit(findingId).then(setEntries).catch(() => {}).finally(() => setLoading(false));
  }, [findingId]);

  const actionColor = (a) => {
    if (a === "confirmed")      return t.sev.critical.fg;
    if (a === "false_positive") return t.status.signed_off[t.mode === "light" ? "light" : "dark"];
    if (a === "escalated")      return t.c.accent;
    return t.c.text2;
  };

  return (
    <InfoBlock theme={t} title="Audit log" accent={t.c.border2}>
      {loading ? (
        <span style={{ color: t.c.text3, fontSize: 12 }}>Loading…</span>
      ) : entries.length === 0 ? (
        <span style={{ color: t.c.text3, fontSize: 12 }}>No audit entries.</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {entries.map((e, i) => {
            const color = actionColor(e.action);
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto",
                gap: 12, alignItems: "start", padding: "8px 12px",
                background: t.c.raised, border: `1px solid ${t.c.border}`, borderRadius: t.radius }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
                  color, background: `${color}18`, border: `1px solid ${color}33`,
                  padding: "1px 6px", borderRadius: t.radius / 2, whiteSpace: "nowrap" }}>
                  {e.action.toUpperCase().replace("_", " ")}
                </span>
                <div>
                  <span style={{ color: t.c.text2, fontSize: 12 }}>{e.analyst}</span>
                  {e.note && (
                    <div style={{ color: t.c.text3, fontSize: 11, marginTop: 3 }}>{e.note}</div>
                  )}
                </div>
                <span style={{ color: t.c.text3, fontSize: 11, whiteSpace: "nowrap" }}>
                  {fmtTs(e.created_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </InfoBlock>
  );
}

// ── Disposition panel ─────────────────────────────────────────────────────────

const DISPOSITIONS = [
  { key: "confirmed",      label: "Confirm",        desc: "Real, actionable vulnerability" },
  { key: "false_positive", label: "False positive",  desc: "Not exploitable in context" },
  { key: "escalated",      label: "Escalate",        desc: "Needs a senior reviewer" },
];

function DispositionPanel({ theme, finding, onUpdate }) {
  const [current, setCurrent] = useState(finding.disposition);
  const [note,    setNote]    = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const t = theme;

  const handleSave = async () => {
    if (!current) return;
    setLoading(true); setError(null);
    try {
      const updated = await setDisposition(finding.id, current, note);
      onUpdate?.(updated); setNote("");
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to update disposition");
    } finally { setLoading(false); }
  };

  const toneFor = (key) => {
    if (key === "confirmed")      return t.sev.critical.fg;
    if (key === "false_positive") return t.status.signed_off[t.mode === "light" ? "light" : "dark"];
    return t.c.accent;
  };

  return (
    <div style={{ background: t.c.surface, border: `1px solid ${t.c.border}`,
      borderRadius: t.radiusLg, padding: 18, display: "flex", flexDirection: "column",
      gap: 14, position: "sticky", top: 24 }}>
      <Label theme={t}>Disposition</Label>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {DISPOSITIONS.map((d) => {
          const active = current === d.key;
          const tone   = toneFor(d.key);
          return (
            <button key={d.key} onClick={() => setCurrent(d.key)} style={{
              display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start",
              textAlign: "left", padding: "11px 14px", borderRadius: t.radius,
              cursor: "pointer", transition: "all 0.14s",
              background: active ? `${tone}1c` : t.c.raised,
              border: `1px solid ${active ? tone : t.c.border}` }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13,
                fontWeight: 600, color: active ? tone : t.c.text, fontFamily: t.fontUi }}>
                <span style={{ width: 9, height: 9, borderRadius: 999,
                  border: `2px solid ${active ? tone : t.c.border2}`,
                  background: active ? tone : "transparent" }} />
                {d.label}
              </span>
              <span style={{ fontSize: 11.5, color: t.c.text3, paddingLeft: 17 }}>{d.desc}</span>
            </button>
          );
        })}
      </div>

      <textarea
        value={note} onChange={e => setNote(e.target.value)}
        placeholder="Add a triage note (optional)…"
        style={{ width: "100%", minHeight: 70, resize: "vertical", padding: "9px 11px",
          fontSize: 12.5, fontFamily: t.fontUi, color: t.c.text, background: t.c.bg,
          border: `1px solid ${t.c.border}`, borderRadius: t.radius, outline: "none" }}
      />

      <Btn theme={t} variant="primary" full size="lg" onClick={handleSave}
        disabled={!current || loading}
        style={{ opacity: current ? 1 : 0.55 }}>
        {loading ? "Saving…" : "Save disposition"}
      </Btn>

      {finding.disposed_by && (
        <div style={{ fontSize: 11.5, color: t.c.text3, textAlign: "center" }}>
          Last set by <span style={{ color: t.c.text2 }}>{finding.disposed_by}</span>
          {finding.disposed_at && <> · {fmtDate(finding.disposed_at)}</>}
        </div>
      )}

      {error && (
        <div style={{ padding: "9px 12px", borderRadius: t.radius,
          background: `${t.sev.critical.fg}14`, border: `1px solid ${t.sev.critical.fg}33`,
          color: t.sev.critical.fg, fontSize: 12 }}>{error}</div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const EXT_LANG = {
  py: "python", js: "javascript", jsx: "javascript", ts: "typescript",
  tsx: "typescript", rb: "ruby", go: "go", java: "java", php: "php",
  sh: "bash", yaml: "yaml", yml: "yaml", json: "json", sql: "sql",
  c: "c", cpp: "cpp", cs: "csharp", rs: "rust",
};

export default function Finding() {
  const { id }       = useParams();
  const navigate     = useNavigate();
  const location     = useLocation();
  const { theme }    = useTheme();
  const fromRepo     = location.state?.repoName;
  const fromSubId    = location.state?.submissionId;
  const [finding, setFinding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const t = theme;

  useEffect(() => {
    getFinding(id)
      .then(setFinding)
      .catch(e => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <div style={{ padding: 60, textAlign: "center", color: t.c.text3, fontSize: 12 }}>
      Loading finding…
    </div>
  );
  if (error) return (
    <div style={{ padding: 24 }}>
      <div style={{ padding: 16, background: `${t.sev.critical.fg}14`,
        border: `1px solid ${t.sev.critical.fg}33`, borderRadius: t.radiusLg,
        color: t.sev.critical.fg }}>{error}</div>
    </div>
  );

  const ext  = finding.file_path?.split(".").pop()?.toLowerCase();
  const lang = EXT_LANG[ext] || "plaintext";
  const meta = t.sev[finding.severity];

  return (
    <div>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${t.c.border}`, background: t.c.surface }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 34px 22px" }}>
          <button
            onClick={() => navigate(fromSubId ? `/submissions/${fromSubId}` : `/submissions/${finding.submission_id}`)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none",
              border: "none", color: t.c.text2, cursor: "pointer", fontSize: 12,
              fontFamily: t.fontUi, padding: 0, marginBottom: 14 }}>
            ← {fromRepo || "Back to submission"}
          </button>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <Severity theme={t} severity={finding.severity} size="lg" />
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 22, fontWeight: 600, color: t.c.text,
                fontFamily: t.fontDisplay, letterSpacing: "-0.02em" }}>{finding.title}</h1>
              <div style={{ fontSize: 12, color: t.c.text3, fontFamily: t.fontMono, marginTop: 6 }}>
                {finding.id}
              </div>
            </div>
            {finding.disposition && (
              <DispositionTag theme={t} disposition={finding.disposition} size="lg" />
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 34px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 26, alignItems: "start" }}>
          {/* Main content */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/* Code */}
            {finding.code_snippet && (
              <InfoBlock theme={t} title="Flagged code" accent={meta.solid}>
                <CodeViewer
                  code={finding.code_snippet}
                  language={lang}
                  lineStart={finding.line_start}
                  lineEnd={finding.line_end}
                  filePath={finding.file_path}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                  {finding.source && (
                    <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11,
                      fontFamily: t.fontMono, color: t.c.text2, background: t.c.raised,
                      border: `1px solid ${t.c.border}` }}>{finding.source}</span>
                  )}
                  {finding.cwe && (
                    <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11,
                      fontFamily: t.fontMono, color: meta.fg, background: meta.bg }}>{finding.cwe}</span>
                  )}
                </div>
              </InfoBlock>
            )}

            {/* Description */}
            {finding.description && (
              <InfoBlock theme={t} title="Description" accent={t.c.accent}>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: t.c.text,
                  fontFamily: t.fontUi, margin: 0, whiteSpace: "pre-wrap" }}>
                  {finding.description}
                </p>
              </InfoBlock>
            )}

            {/* LLM reasoning */}
            {finding.llm_reasoning && (
              <InfoBlock theme={t} title="LLM analysis" accent={t.c.accent}>
                <div style={{ fontSize: 10.5, color: t.c.text3, fontFamily: t.fontMono,
                  letterSpacing: "0.05em", marginBottom: 10 }}>
                  qwen2.5-coder · local inference
                </div>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: t.c.text,
                  fontFamily: t.fontUi, margin: 0 }}>
                  {finding.llm_reasoning}
                </p>
              </InfoBlock>
            )}

            {/* Remediation */}
            {finding.remediation && (
              <InfoBlock theme={t} title="Recommended fix"
                accent={t.status.signed_off[t.mode === "light" ? "light" : "dark"]}>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: t.c.text,
                  fontFamily: t.fontUi, margin: 0 }}>
                  {finding.remediation}
                </p>
              </InfoBlock>
            )}

            {/* Audit log */}
            <AuditLog theme={t} findingId={finding.id} />
          </div>

          {/* Disposition sidebar */}
          <DispositionPanel theme={t} finding={finding} onUpdate={setFinding} />
        </div>
      </div>
    </div>
  );
}
