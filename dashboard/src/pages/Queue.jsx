import React, { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { listSubmissions, getActiveLlmJobs, getLlmStatus } from "../api/submissions.js";
import { listGroups } from "../api/groups.js";
import SeverityBadge from "../components/SeverityBadge.jsx";
import StatusBadge from "../components/StatusBadge.jsx";

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const FILTERS = [
  { key: null,         label: "ALL" },
  { key: "pending",    label: "PENDING" },
  { key: "analyzing",  label: "ANALYZING" },
  { key: "reviewed",   label: "REVIEWED" },
  { key: "signed_off", label: "SIGNED OFF" },
];

// Thin progress bar shown at the bottom of a row when an LLM re-run is active.
function RowProgressBar({ submissionId }) {
  const [llm, setLlm] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await getLlmStatus(submissionId);
        if (!cancelled) {
          setLlm(s);
          if (s.status !== "running" && s.status !== "queued") {
            clearInterval(pollRef.current);
          }
        }
      } catch { /* ignore */ }
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(pollRef.current); };
  }, [submissionId]);

  if (!llm || (llm.status !== "running" && llm.status !== "queued")) return null;

  const pct = llm.status === "queued" ? 4 : Math.round(llm.progress * 100);
  const remaining = llm.status === "running" && llm.estimated > 0
    ? Math.max(0, Math.round(llm.estimated - llm.elapsed))
    : null;

  return (
    <div style={{ gridColumn: "1 / -1", paddingTop: "4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "5px" }}>
        <span style={{ fontSize: "10px", color: "var(--accent)", fontWeight: 600, letterSpacing: "0.06em" }}>
          LLM {llm.status === "queued" ? "QUEUED" : "RUNNING"}
        </span>
        <span style={{ fontSize: "10px", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          {llm.status === "running"
            ? `${pct}%${remaining !== null ? ` · ~${remaining}s` : ""}`
            : "waiting for worker"}
        </span>
      </div>
      <div style={{ height: "3px", background: "var(--border)", borderRadius: "2px", overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: "var(--accent)",
          borderRadius: "2px",
          transition: "width 1.8s ease-out",
          animation: llm.status === "queued" ? "qpulse 1.4s ease-in-out infinite" : "none",
        }} />
      </div>
      <style>{`@keyframes qpulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>
    </div>
  );
}

export default function Queue() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [groups, setGroups] = useState([]);
  // Set of submission IDs with active LLM jobs.
  const [activeJobs, setActiveJobs] = useState(new Set());
  const activeRef = useRef(null);

  useEffect(() => { listGroups().then(setGroups).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listSubmissions(filter, groupId);
      setData(res);
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to load submissions");
    } finally {
      setLoading(false);
    }
  }, [filter, groupId]);

  useEffect(() => { load(); }, [load]);

  // Poll for active LLM jobs every 3s.
  useEffect(() => {
    const poll = async () => {
      try {
        const ids = await getActiveLlmJobs();
        setActiveJobs(new Set(ids));
      } catch { /* ignore */ }
    };
    poll();
    activeRef.current = setInterval(poll, 3000);
    return () => clearInterval(activeRef.current);
  }, []);

  const subs = data?.submissions || [];

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
        <div>
          <h1 style={{ fontSize: "18px", fontWeight: 600, color: "var(--text)", fontFamily: "var(--sans)", letterSpacing: "-0.02em" }}>
            Review Queue
          </h1>
          <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "2px" }}>
            {data ? `${data.total} submission${data.total !== 1 ? "s" : ""}` : "Loading..."}
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: "6px 12px", background: "var(--bg-3)",
            border: "1px solid var(--border)", borderRadius: "var(--radius)",
            color: "var(--text-2)", fontSize: "11px", cursor: loading ? "not-allowed" : "pointer",
            fontFamily: "var(--mono)", letterSpacing: "0.06em",
            transition: "all 0.15s", opacity: loading ? 0.5 : 1,
          }}
          onMouseEnter={e => { if (!loading) e.target.style.borderColor = "var(--border-2)"; }}
          onMouseLeave={e => e.target.style.borderColor = "var(--border)"}
        >
          {loading ? "..." : "↻ REFRESH"}
        </button>
      </div>

      {/* Group filter */}
      {groups.length > 0 && (
        <div style={{ display: "flex", gap: "6px", marginBottom: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.06em", marginRight: "2px" }}>GROUP</span>
          {[{ id: null, name: "ALL" }, ...groups].map(g => (
            <button
              key={String(g.id)}
              onClick={() => setGroupId(g.id)}
              style={{
                padding: "3px 10px", borderRadius: "var(--radius)", cursor: "pointer",
                fontSize: "10px", fontFamily: "var(--mono)", letterSpacing: "0.06em",
                border: groupId === g.id ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: groupId === g.id ? "rgba(255,160,0,0.1)" : "transparent",
                color: groupId === g.id ? "var(--accent)" : "var(--text-3)",
                transition: "all 0.1s",
              }}
            >{g.name}</button>
          ))}
        </div>
      )}

      {/* Status Filters */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap" }}>
        {FILTERS.map(f => (
          <button
            key={String(f.key)}
            onClick={() => setFilter(f.key)}
            style={{
              padding: "4px 12px",
              background: filter === f.key ? "var(--accent-dim)" : "var(--bg-3)",
              border: `1px solid ${filter === f.key ? "var(--accent)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
              color: filter === f.key ? "var(--accent)" : "var(--text-3)",
              fontSize: "10px", fontWeight: 600, letterSpacing: "0.08em",
              cursor: "pointer", fontFamily: "var(--mono)", transition: "all 0.15s",
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ padding: "12px 16px", background: "var(--red-dim)", border: "1px solid #f8514933", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "12px", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
        {/* thead */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr 100px 80px 100px",
          padding: "8px 16px",
          background: "var(--bg-3)",
          borderBottom: "1px solid var(--border)",
          gap: "12px",
        }}>
          {["REPO / COMMIT", "BRANCH / PR", "SUBMITTER", "SUBMITTED", "CRIT+HIGH", "STATUS"].map(h => (
            <span key={h} style={{ fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.1em", fontWeight: 600 }}>{h}</span>
          ))}
        </div>

        {loading && subs.length === 0 && (
          <div style={{ padding: "40px", textAlign: "center", color: "var(--text-3)", fontSize: "12px" }}>
            Loading submissions...
          </div>
        )}

        {!loading && subs.length === 0 && (
          <div style={{ padding: "40px", textAlign: "center", color: "var(--text-3)", fontSize: "12px" }}>
            No submissions found.
          </div>
        )}

        {subs.map((sub, idx) => {
          const isActive = activeJobs.has(sub.id);
          return (
            <Link key={sub.id} to={`/submissions/${sub.id}`} style={{ textDecoration: "none", display: "block" }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr 1fr 100px 80px 100px",
                padding: isActive ? "12px 16px 10px" : "12px 16px",
                gap: "12px",
                alignItems: "center",
                borderBottom: idx < subs.length - 1 ? "1px solid var(--border)" : "none",
                borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                background: isActive ? "rgba(240,165,0,0.03)" : "var(--bg-2)",
                transition: "background 0.1s",
                cursor: "pointer",
              }}
                onMouseEnter={e => e.currentTarget.style.background = isActive ? "rgba(240,165,0,0.06)" : "var(--bg-3)"}
                onMouseLeave={e => e.currentTarget.style.background = isActive ? "rgba(240,165,0,0.03)" : "var(--bg-2)"}
              >
                {/* Repo */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text)", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {sub.repo_full_name || "—"}
                  </div>
                  {sub.commit_sha && (
                    <div style={{ color: "var(--text-3)", fontSize: "11px", marginTop: "2px", fontFamily: "var(--mono)" }}>
                      {sub.commit_sha.slice(0, 8)}
                    </div>
                  )}
                </div>

                {/* Branch */}
                <div style={{ minWidth: 0 }}>
                  {sub.branch ? (
                    <span style={{
                      display: "inline-block", fontSize: "11px", color: "var(--blue)",
                      background: "var(--blue-dim)", padding: "1px 7px",
                      borderRadius: "3px", border: "1px solid rgba(56,139,253,0.2)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
                    }}>
                      {sub.branch}
                    </span>
                  ) : "—"}
                </div>

                {/* Submitter */}
                <div style={{ color: "var(--text-2)", fontSize: "12px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {sub.submitter || sub.github_actor || "—"}
                </div>

                {/* Submitted */}
                <div style={{ color: "var(--text-3)", fontSize: "11px" }}>
                  {fmtDate(sub.created_at)}
                </div>

                {/* Crit+High */}
                <div><CritHighCount sub={sub} /></div>

                {/* Status */}
                <div><StatusBadge status={sub.status} /></div>

                {/* Progress bar — spans all columns, only rendered when active */}
                {isActive && <RowProgressBar submissionId={sub.id} />}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function CritHighCount({ sub }) {
  if (sub.finding_counts) {
    const n = (sub.finding_counts.critical || 0) + (sub.finding_counts.high || 0);
    if (n === 0) return <span style={{ color: "var(--text-3)", fontSize: "11px" }}>—</span>;
    return <SeverityBadge severity={n > 0 ? (sub.finding_counts.critical > 0 ? "critical" : "high") : "info"} />;
  }
  return <span style={{ color: "var(--text-3)", fontSize: "11px" }}>—</span>;
}
