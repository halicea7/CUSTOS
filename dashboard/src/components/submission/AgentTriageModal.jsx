// Paste an AI agent's verdict table (REMEDIATIONS.md, step 8), review each row, apply as decisions.
// Every decision is the analyst's: nothing is applied until they press Apply.
import React, { useMemo, useState } from "react";
import { Modal } from "../ui.jsx";
import { useTheme } from "../../App.jsx";
import { useAgentTriage } from "../../api/queries.js";
import { errorMessage } from "../../api/errors.js";
import { useToast } from "../Toast.jsx";
import { SevPill } from "./FindingDetail.jsx";
import { VERDICT_DECISION, parseAgentTriage } from "./report.js";

const DECISIONS = [["confirmed", "Confirm"], ["false_positive", "False positive"], ["escalated", "Escalate"], ["", "No decision"]];
const CURRENT = { confirmed: "Confirmed", false_positive: "False positive", escalated: "Escalated" };
const BLOCKING = new Set(["critical", "high"]);

export default function AgentTriageModal({ sub, findings, onClose }) {
  const { theme } = useTheme();
  const toast = useToast();
  const apply = useAgentTriage(sub.id);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState({});   // ref -> decision ("" = none), overriding the default
  const { rows, problems } = useMemo(() => parseAgentTriage(text, findings), [text, findings]);

  // Default: the verdict's decision, except for findings someone already decided.
  const decisionOf = (r) => (r.ref in choice ? choice[r.ref] : r.finding.disposition ? "" : VERDICT_DECISION[r.verdict] || "");
  const picked = rows.filter((r) => decisionOf(r));
  const weak = picked.filter((r) => decisionOf(r) === "false_positive" && BLOCKING.has(r.finding.severity)
    && r.reason.split(/\s+/).filter(Boolean).length < 4);

  const submit = () => apply.mutate(picked.map((r) => ({
    finding_id: r.finding.id, disposition: decisionOf(r), verdict: r.verdict,
    action: r.action || null, reason: r.reason || "No reason given",
  })), {
    onSuccess: (updated) => { toast(`Recorded ${updated.length} decision${updated.length !== 1 ? "s" : ""} from the agent's results`); onClose(); },
  });

  return (
    <Modal theme={theme} title="Paste agent results" onClose={onClose} width={860}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="dim">
          Paste the summary table your AI agent wrote after working through <b>REMEDIATIONS.md</b>. Check each row:
          the decisions are recorded under your name, with a note that they came from the agent.
        </div>
        <textarea className="input textarea mono" rows={rows.length ? 4 : 9} value={text} autoFocus
          placeholder={"| ID | Ref | Verdict | Action | Reason |\n|----|-----|---------|--------|--------|\n| R-01 | 1a2b3c4d | valid | changed | … |"}
          onChange={(e) => { setText(e.target.value); setChoice({}); }} style={{ fontSize: ".78rem" }} />

        {problems.length > 0 && (
          <div className="banner note" style={{ margin: 0 }}>
            <b>{problems.length} row{problems.length !== 1 ? "s" : ""} skipped:</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{problems.slice(0, 8).map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        )}
        {text.trim() && !rows.length && !problems.length && (
          <div className="result bad">No rows found. The table needs a Ref column with each finding&rsquo;s 8-character ref.</div>
        )}

        {rows.length > 0 && (
          <div style={{ maxHeight: "46vh", overflow: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
            <table className="tbl" style={{ width: "100%", fontSize: ".8rem" }}>
              <thead><tr><th>Finding</th><th>Agent</th><th>Reason</th><th style={{ width: 150 }}>Decision</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ref}>
                    <td style={{ minWidth: 220 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <SevPill sev={r.finding.severity} /><span className="mono dim">{r.rid || r.ref}</span>
                      </div>
                      <div style={{ marginTop: 3, color: "var(--text)" }}>{r.finding.title}</div>
                      {r.finding.disposition && (
                        <div className="dim" style={{ fontSize: ".74rem" }}>
                          Already {CURRENT[r.finding.disposition]} by {r.finding.disposed_by || "someone"}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}><b>{r.verdict}</b>{r.action && <div className="dim">{r.action}</div>}</td>
                    <td style={{ overflowWrap: "anywhere" }}>{r.reason || <span className="dim">—</span>}</td>
                    <td>
                      <select className="input" value={decisionOf(r)} aria-label={`Decision for ${r.rid || r.ref}`}
                        onChange={(e) => setChoice((c) => ({ ...c, [r.ref]: e.target.value }))}>
                        {DECISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {weak.length > 0 && (
          <div className="result bad">
            Dismissing a critical or high finding needs a real reason. Change the decision for {weak.map((r) => r.rid || r.ref).join(", ")} or
            ask the agent to explain.
          </div>
        )}
        {apply.error && <div className="result bad">{errorMessage(apply.error, "That didn't work")}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {rows.length > 0 && <span className="dim" style={{ marginRight: "auto" }}>
            {picked.length} of {rows.length} will be recorded</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!picked.length || weak.length > 0 || apply.isPending}>
            {apply.isPending ? <><span className="spin" /> Saving</> : `Apply ${picked.length || ""}`.trim()}
          </button>
        </div>
      </div>
    </Modal>
  );
}
