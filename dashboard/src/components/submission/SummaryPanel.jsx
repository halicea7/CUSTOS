import React, { useState } from "react";
import { Label, Severity, SEV_ORDER, Btn } from "../atoms.jsx";
import { useSignOff } from "../../api/queries.js";
import { errorMessage } from "../../api/errors.js";

export default function SummaryPanel({ theme, sub, findings }) {
  const [note,      setNote]      = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const signOff = useSignOff(sub.id);
  const loading = signOff.isPending;
  const error = signOff.error ? errorMessage(signOff.error, "Sign-off failed") : null;
  const t = theme;

  const critHigh  = findings.filter(f => f.severity === "critical" || f.severity === "high");
  const actioned  = critHigh.filter(f => f.disposition != null);
  const allTriaged = findings.length > 0 && findings.filter(f => !f.disposition).length === 0;
  const gateOpen  = critHigh.length === 0 || actioned.length === critHigh.length;
  const alreadySigned = sub.status === "signed_off";
  const canSignOff = sub.status === "needs_review";
  const green = t.status.signed_off[t.mode === "light" ? "light" : "dark"];

  const handleSignOff = () => {
    if (!gateOpen || loading || !canSignOff) return;
    signOff.mutate(note, { onSettled: () => setConfirmed(false) });
  };

  const counts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1; return acc;
  }, {});
  const triaged = findings.filter(f => f.disposition).length;
  const total   = findings.length;

  return (
    <div style={{ background: t.c.surface, border: `1px solid ${t.c.border}`,
      borderRadius: t.radiusLg, padding: 18, display: "flex", flexDirection: "column",
      gap: 16, position: "sticky", top: 24 }}>

      {/* Severity breakdown */}
      <div>
        <Label theme={t}>Severity breakdown</Label>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
          {SEV_ORDER.map((k) => (
            <div key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Severity theme={t} severity={k} />
              <span style={{ fontSize: 13, fontFamily: t.fontMono, fontWeight: 600,
                color: counts[k] ? t.sev[k].fg : t.c.text3 }}>{counts[k] || 0}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ height: 1, background: t.c.border }} />

      {/* Triage progress */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: t.c.text2 }}>Triage progress</span>
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.c.text }}>{triaged}/{total}</span>
        </div>
        <div style={{ height: 6, background: t.c.border, borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: total ? `${(triaged / total) * 100}%` : "0%",
            background: allTriaged ? green : t.c.accent, borderRadius: 999, transition: "width 0.4s" }} />
        </div>
      </div>

      {/* Sign-off */}
      {alreadySigned ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 14px",
          borderRadius: t.radius, background: `${green}18`, color: green, fontSize: 12.5, fontWeight: 600 }}>
          ✓ Signed off{sub.signed_by ? ` by ${sub.signed_by}` : ""}
        </div>
      ) : !canSignOff ? (
        <div style={{ padding: "9px 12px", borderRadius: t.radius, background: t.c.raised,
          border: `1px solid ${t.c.border}`, fontSize: 12, color: t.c.text2 }}>
          Sign-off is available once analysis has finished successfully.
        </div>
      ) : (
        <div>
          {!gateOpen && (
            <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: t.radius,
              background: `${t.sev.critical.fg}0e`, border: `1px solid ${t.sev.critical.fg}22`,
              fontSize: 12, color: t.c.text2 }}>
              <span style={{ color: t.sev.critical.fg, fontWeight: 600 }}>
                {critHigh.length - actioned.length} critical/high
              </span>
              {" "}still need disposition.
            </div>
          )}
          {gateOpen && !confirmed && (
            <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: t.radius,
              background: `${t.c.accent}0e`, border: `1px solid ${t.c.accent}22`,
              fontSize: 12, color: t.c.text2 }}>
              <span style={{ color: t.c.accent }}>Ready for sign-off.</span>
            </div>
          )}
          {gateOpen && (
            <>
              <textarea
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="Sign-off note (optional)"
                rows={2}
                style={{ width: "100%", resize: "vertical", padding: "9px 11px", fontSize: 12.5,
                  fontFamily: t.fontUi, color: t.c.text, background: t.c.bg,
                  border: `1px solid ${t.c.border}`, borderRadius: t.radius, outline: "none",
                  marginBottom: 12 }}
              />
              {!confirmed ? (
                <Btn theme={t} variant="primary" full size="lg" onClick={() => setConfirmed(true)}>
                  Sign off submission
                </Btn>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn theme={t} variant="success" full onClick={handleSignOff} disabled={loading}>
                    {loading ? "Signing off…" : "✓ Confirm sign-off"}
                  </Btn>
                  <Btn theme={t} onClick={() => setConfirmed(false)} disabled={loading}>Cancel</Btn>
                </div>
              )}
            </>
          )}
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
