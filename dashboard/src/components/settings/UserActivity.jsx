// One user's history on the Users tab: sign-ins, repository and admin actions,
// plus their triage and sign-offs (bulk decisions arrive already folded).
import React, { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import api from "../../api/client.js";
import { errorMessage } from "../../api/errors.js";
import { ago } from "../queue/Board.jsx";

const ACTIONS = {
  login: ["Signed in", "var(--ok)"],
  login_failed: ["Failed sign-in (wrong password)", "var(--crit)"],
  password_changed: ["Changed their password", "var(--accent)"],
  repo_added: ["Added repository", "var(--accent)"],
  repo_removed: ["Removed repository", "var(--crit)"],
  repo_enabled: ["Resumed scanning", "var(--ok)"],
  repo_disabled: ["Paused scanning", "var(--high)"],
  repo_token_replaced: ["Replaced the GitHub token", "var(--accent)"],
  repo_checked: ["Checked for updates", "var(--text3)"],
  repo_shared: ["Shared repository", "var(--accent)"],
  repo_unshared: ["Stopped sharing repository", "var(--text3)"],
  false_positive: ["Marked false positive", "var(--ok)"],
  confirmed: ["Confirmed", "var(--crit)"],
  escalated: ["Escalated", "var(--accent)"],
  sign_off: ["Signed off (final)", "var(--ok)"],
  analyst_sign_off: ["Signed off for approval", "var(--low)"],
  sign_off_returned: ["Sent a sign-off back", "var(--high)"],
  agent_triage: ["Applied AI agent results", "var(--accent)"],
  delete_submission: ["Deleted a run", "var(--crit)"],
  user_created: ["Created user", "var(--accent)"],
  user_role_changed: ["Changed a role", "var(--high)"],
  user_deleted: ["Deleted user", "var(--crit)"],
  group_created: ["Created group", "var(--accent)"],
  group_renamed: ["Renamed group", "var(--text3)"],
  group_deleted: ["Deleted group", "var(--crit)"],
  member_added: ["Added to group", "var(--accent)"],
  member_removed: ["Removed from group", "var(--text3)"],
  settings_changed: ["Changed analysis settings", "var(--high)"],
  retention_changed: ["Changed Bedrock data retention", "var(--high)"],
  self_check: ["Ran a self-check", "var(--text3)"],
  llm_rerun: ["Re-ran the LLM review", "var(--accent)"],
};
const TRIAGE = new Set(["false_positive", "confirmed", "escalated"]);
const FILTERS = [["all", "All"], ["triage", "Triage"], ["repos", "Repositories"], ["access", "Sign-ins"], ["admin", "Admin"]];
const kindOf = (a) => (TRIAGE.has(a) || ["sign_off", "analyst_sign_off", "sign_off_returned", "delete_submission", "llm_rerun"].includes(a) ? "triage"
  : a.startsWith("repo_") ? "repos" : a.startsWith("login") || a === "password_changed" ? "access" : "admin");

export default function UserActivity({ user }) {
  const navigate = useNavigate();
  const [limit, setLimit] = useState(50);
  const [filter, setFilter] = useState("all");
  const { data, isPending, error, isFetching } = useQuery({
    queryKey: ["users", user.id, "activity", limit],
    queryFn: () => api.get(`/settings/users/${user.id}/activity`, { params: { limit } }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  if (error) return <div className="result bad">{errorMessage(error, "Couldn't load the activity")}</div>;
  if (isPending) return <div className="muted" style={{ padding: "6px 0" }}>Loading…</div>;
  const items = data.items.filter((i) => filter === "all" || kindOf(i.action) === filter);

  return (
    <div className="ulog">
      <div className="ulog-h">
        <b>Activity</b>
        <div className="chips">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="muted" style={{ padding: "8px 0" }}>
          {data.items.length ? "Nothing of this kind yet." : "No activity recorded yet."}
        </div>
      ) : items.map((i, n) => {
        const [label, color] = ACTIONS[i.action] || [i.action.replaceAll("_", " "), "var(--text3)"];
        const findings = TRIAGE.has(i.action) && i.count ? `${i.count} finding${i.count !== 1 ? "s" : ""}` : null;
        return (
          <div key={n} className={`ulog-row ${i.submission_id ? "click" : ""}`}
            onClick={i.submission_id ? () => navigate(`/submissions/${i.submission_id}`) : undefined}
            title={i.submission_id ? "Open the run" : undefined}>
            <span className="dot" style={{ background: color }} />
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <span style={{ color: "var(--text)" }}>{label}</span>
              {findings && <> · {findings}</>}
              {i.repo && <> · <span className="mono">{i.repo}</span>{i.commit && <span className="muted mono"> @{i.commit}</span>}</>}
              {i.detail && <span className="muted"> · {TRIAGE.has(i.action) || i.action === "sign_off" ? `“${i.detail}”` : i.detail}</span>}
            </span>
            <time title={new Date(i.at).toLocaleString()}>{ago(i.at)}</time>
          </div>
        );
      })}
      {data.more && limit < 500 && (
        <button className="btn sm" style={{ marginTop: 8 }} disabled={isFetching} onClick={() => setLimit((l) => Math.min(500, l + 100))}>
          {isFetching ? <><span className="spin" /> Loading</> : "Show older"}
        </button>
      )}
    </div>
  );
}
