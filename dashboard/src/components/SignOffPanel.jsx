import React, { useState } from "react";
import { signOff } from "../api/submissions.js";

export default function SignOffPanel({ submission, findings, onSignOff }) {
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirmed, setConfirmed] = useState(false);

  const critHigh = findings.filter(f => f.severity === "critical" || f.severity === "high");
  const actioned = critHigh.filter(f => f.disposition != null);
  const unactioned = critHigh.length - actioned.length;
  const gateOpen = unactioned === 0;
  const alreadySigned = submission.status === "signed_off";

  const handleSignOff = async () => {
    if (!gateOpen || loading || alreadySigned) return;
    setLoading(true);
    setError(null);
    try {
      const updated = await signOff(submission.id, note);
      onSignOff?.(updated);
    } catch (e) {
      setError(e.response?.data?.detail || "Sign-off failed");
    } finally {
      setLoading(false);
      setConfirmed(false);
    }
  };

  return (
    <div style={{
      border: `1px solid ${alreadySigned ? "#3fb95033" : gateOpen ? "var(--accent)" : "var(--border)"}`,
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
      background: alreadySigned ? "rgba(63,185,80,0.04)" : "var(--bg-2)",
      transition: "border-color 0.3s",
    }}>
      <div style={{
        padding: "10px 16px",
        borderBottom: `1px solid ${alreadySigned ? "#3fb95033" : gateOpen ? "rgba(240,165,0,0.2)" : "var(--border)"}`,
        background: alreadySigned ? "rgba(63,185,80,0.06)" : gateOpen ? "rgba(240,165,0,0.05)" : "var(--bg-3)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{
          fontSize: "11px", letterSpacing: "0.08em", fontWeight: 600,
          color: alreadySigned ? "#3fb950" : gateOpen ? "var(--accent)" : "var(--text-2)",
        }}>
          {alreadySigned ? "✓ SIGNED OFF" : "SIGN-OFF"}
        </span>
        <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
          {critHigh.length === 0
            ? "no critical/high findings"
            : `${actioned.length} / ${critHigh.length} critical+high actioned`}
        </span>
      </div>

      <div style={{ padding: "16px" }}>
        {alreadySigned ? (
          <div style={{ color: "#3fb950", fontSize: "12px" }}>
            This submission has been signed off and the GitHub check has been updated to success.
          </div>
        ) : (
          <>
            <div style={{ marginBottom: "12px" }}>
              {!gateOpen ? (
                <div style={{
                  padding: "10px 14px",
                  background: "rgba(248,81,73,0.06)",
                  border: "1px solid rgba(248,81,73,0.2)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-2)",
                  fontSize: "12px",
                }}>
                  <span style={{ color: "#f85149", fontWeight: 600 }}>
                    {unactioned} finding{unactioned !== 1 ? "s" : ""}
                  </span>
                  {" "}require a disposition before sign-off.
                </div>
              ) : (
                <div style={{
                  padding: "10px 14px",
                  background: "rgba(240,165,0,0.06)",
                  border: "1px solid rgba(240,165,0,0.2)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-2)",
                  fontSize: "12px",
                }}>
                  All critical/high findings actioned.{" "}
                  <span style={{ color: "var(--accent)" }}>Ready for sign-off.</span>
                </div>
              )}
            </div>

            {gateOpen && (
              <>
                <textarea
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Sign-off note (optional)"
                  rows={2}
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

                {!confirmed ? (
                  <button
                    onClick={() => setConfirmed(true)}
                    style={{
                      width: "100%", padding: "10px",
                      background: "var(--accent-dim)",
                      border: "1px solid var(--accent)",
                      borderRadius: "var(--radius)",
                      color: "var(--accent)",
                      fontSize: "12px", fontWeight: 700,
                      letterSpacing: "0.1em", cursor: "pointer",
                      fontFamily: "var(--mono)",
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { e.target.style.background = "rgba(240,165,0,0.2)"; }}
                    onMouseLeave={e => { e.target.style.background = "var(--accent-dim)"; }}
                  >
                    SIGN OFF SUBMISSION
                  </button>
                ) : (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={handleSignOff}
                      disabled={loading}
                      style={{
                        flex: 1, padding: "10px",
                        background: loading ? "var(--bg-3)" : "#3fb950",
                        border: "1px solid #3fb950",
                        borderRadius: "var(--radius)",
                        color: loading ? "var(--text-3)" : "#0a0c0f",
                        fontSize: "12px", fontWeight: 700,
                        letterSpacing: "0.08em", cursor: loading ? "not-allowed" : "pointer",
                        fontFamily: "var(--mono)",
                        transition: "all 0.15s",
                      }}
                    >
                      {loading ? "SIGNING OFF..." : "CONFIRM SIGN-OFF"}
                    </button>
                    <button
                      onClick={() => setConfirmed(false)}
                      disabled={loading}
                      style={{
                        padding: "10px 16px",
                        background: "var(--bg-3)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius)",
                        color: "var(--text-2)",
                        fontSize: "11px", cursor: "pointer",
                        fontFamily: "var(--mono)",
                        transition: "all 0.15s",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {error && (
          <div style={{ marginTop: "10px", padding: "8px 12px", background: "var(--red-dim)", border: "1px solid #f8514933", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "12px" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
