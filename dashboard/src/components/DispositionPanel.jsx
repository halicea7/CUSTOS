import React, { useState } from "react";
import { setDisposition } from "../api/findings.js";

const ACTIONS = [
  { key: "confirmed",      label: "Confirm",            color: "#f85149", desc: "Genuine vulnerability" },
  { key: "false_positive", label: "False Positive",     color: "#3fb950", desc: "Not a real issue" },
  { key: "escalated",      label: "Escalate",           color: "#bc8cff", desc: "Needs further review" },
];

function fmt(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function DispositionPanel({ finding, onUpdate }) {
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const current = finding.disposition;

  const handleAction = async (disposition) => {
    setLoading(true);
    setError(null);
    try {
      const updated = await setDisposition(finding.id, disposition, note);
      onUpdate?.(updated);
      setNote("");
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to update disposition");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
      background: "var(--bg-2)",
    }}>
      <div style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-3)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontSize: "11px", color: "var(--text-2)", letterSpacing: "0.08em", fontWeight: 600 }}>
          DISPOSITION
        </span>
        {current && (
          <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
            {finding.disposed_by && <span style={{ color: "var(--text-2)" }}>{finding.disposed_by}</span>}
            {finding.disposed_at && <span> · {fmt(finding.disposed_at)}</span>}
          </span>
        )}
      </div>

      <div style={{ padding: "16px" }}>
        {current ? (
          <div style={{
            padding: "10px 14px",
            borderRadius: "var(--radius)",
            background: "var(--bg-3)",
            border: "1px solid var(--border)",
            marginBottom: "12px",
          }}>
            <span style={{ fontSize: "11px", color: "var(--text-3)", marginRight: "8px" }}>current:</span>
            <span style={{
              fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em",
              color: ACTIONS.find(a => a.key === current)?.color || "var(--text)",
            }}>
              {current.toUpperCase().replace("_", " ")}
            </span>
          </div>
        ) : (
          <div style={{ marginBottom: "12px", padding: "8px 12px", background: "var(--bg-3)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
            <span style={{ fontSize: "11px", color: "var(--text-3)" }}>No disposition set — action required for critical/high findings.</span>
          </div>
        )}

        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Optional note (analyst comments, ticket reference, etc.)"
          rows={3}
          style={{
            width: "100%", resize: "vertical",
            background: "var(--bg-3)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", color: "var(--text)",
            fontFamily: "var(--mono)", fontSize: "12px", padding: "8px 10px",
            outline: "none", marginBottom: "12px",
            transition: "border-color 0.15s",
          }}
          onFocus={e => e.target.style.borderColor = "var(--border-2)"}
          onBlur={e => e.target.style.borderColor = "var(--border)"}
        />

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {ACTIONS.map(action => (
            <button
              key={action.key}
              disabled={loading}
              onClick={() => handleAction(action.key)}
              title={action.desc}
              style={{
                flex: 1, minWidth: "120px",
                padding: "8px 12px",
                background: current === action.key ? `${action.color}1a` : "var(--bg-3)",
                border: `1px solid ${current === action.key ? action.color : "var(--border)"}`,
                borderRadius: "var(--radius)",
                color: current === action.key ? action.color : "var(--text-2)",
                fontSize: "11px", fontWeight: 600, letterSpacing: "0.06em",
                cursor: loading ? "not-allowed" : "pointer",
                transition: "all 0.15s",
                fontFamily: "var(--mono)",
                opacity: loading ? 0.5 : 1,
              }}
              onMouseEnter={e => {
                if (!loading) {
                  e.currentTarget.style.borderColor = action.color;
                  e.currentTarget.style.color = action.color;
                  e.currentTarget.style.background = `${action.color}11`;
                }
              }}
              onMouseLeave={e => {
                if (current !== action.key) {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.color = "var(--text-2)";
                  e.currentTarget.style.background = "var(--bg-3)";
                }
              }}
            >
              {action.label}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ marginTop: "10px", padding: "8px 12px", background: "var(--red-dim)", border: "1px solid #f8514933", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "12px" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
