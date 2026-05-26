import React, { useCallback, useEffect, useRef, useState } from "react";
import { getHealthStatus, getScanFindings, listScans, triggerScan } from "../api/health.js";
import { useAuth } from "../App.jsx";

// ── constants ────────────────────────────────────────────────────────────────

const SEV_COLOR = {
  critical: { fg: "#f85149", bg: "rgba(248,81,73,0.08)", border: "#f85149" },
  high:     { fg: "#e3650a", bg: "rgba(227,101,10,0.08)", border: "#e3650a" },
  medium:   { fg: "#d29922", bg: "rgba(210,153,34,0.08)", border: "#d29922" },
  low:      { fg: "#388bfd", bg: "rgba(56,139,253,0.08)", border: "#388bfd" },
  info:     { fg: "#484f58", bg: "rgba(72,79,88,0.08)",   border: "#484f58" },
};

const HEALTH_STYLE = {
  urgent:  { color: "#f85149", label: "URGENT",  dot: "#f85149" },
  warning: { color: "#e3650a", label: "WARNING", dot: "#e3650a" },
  healthy: { color: "#3fb950", label: "HEALTHY", dot: "#3fb950" },
};

const CAT_LABEL = {
  sast:         "SAST",
  secrets:      "SECRETS",
  dependencies: "DEPENDENCIES",
  config:       "CONFIG",
  llm:          "LLM",
};

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const CATEGORY_ORDER = ["sast", "secrets", "dependencies", "config", "llm"];

// Stages run concurrently in phase 1 (SAST tools), then LLM runs after.
// doneAfter is an optimistic estimate in seconds used only for the UI indicator.
const SCAN_STAGES = [
  { id: "config",  label: "Config Checks",    tool: "internal",   doneAfter: 3,        startAfter: 0  },
  { id: "sast",    label: "SAST Analysis",    tool: "semgrep",    doneAfter: 22,       startAfter: 0  },
  { id: "secrets", label: "Secret Detection", tool: "gitleaks",   doneAfter: 14,       startAfter: 0  },
  { id: "deps",    label: "Dependency Audit", tool: "pip-audit",  doneAfter: 32,       startAfter: 0  },
  { id: "llm",     label: "LLM Review",       tool: "local model",doneAfter: Infinity, startAfter: 28 },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function relativeTime(isoStr) {
  if (!isoStr) return "—";
  const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtDuration(scan) {
  if (!scan.started_at || !scan.finished_at) return "—";
  const s = (new Date(scan.finished_at) - new Date(scan.started_at)) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtElapsed(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function totalFindings(counts) {
  if (!counts) return 0;
  return Object.values(counts).reduce((s, v) => s + v, 0);
}

// ── ScanProgressBar ───────────────────────────────────────────────────────────

function ScanProgressBar() {
  return (
    <div style={{
      position: "relative", height: "2px",
      background: "var(--border)", borderRadius: "2px",
      overflow: "hidden", marginBottom: "20px",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0,
        width: "40%", height: "100%",
        background: "linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%)",
        animation: "scanSweep 1.8s ease-in-out infinite",
        borderRadius: "2px",
      }} />
    </div>
  );
}

// ── ScanStagesPanel ───────────────────────────────────────────────────────────

function StageIcon({ state }) {
  if (state === "done") {
    return (
      <span style={{ color: "#3fb950", fontSize: "12px", width: 16, textAlign: "center", flexShrink: 0 }}>✓</span>
    );
  }
  if (state === "running") {
    return (
      <span style={{
        display: "inline-block", width: 8, height: 8,
        borderRadius: "50%", background: "var(--accent)", flexShrink: 0,
        margin: "0 4px",
        animation: "stagePulse 1s ease-in-out infinite",
        boxShadow: "0 0 6px var(--accent)",
      }} />
    );
  }
  // pending
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      border: "1px solid var(--border-2)", flexShrink: 0, margin: "0 4px",
    }} />
  );
}

function ScanStagesPanel({ elapsed }) {
  const llmEstimate = 90; // rough LLM estimate for indeterminate bar

  return (
    <div style={{
      background: "var(--bg-2)",
      border: "1px solid rgba(240,165,0,0.25)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
      marginBottom: "24px",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 20px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(240,165,0,0.04)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: "var(--accent)",
            animation: "stagePulse 1s ease-in-out infinite",
            boxShadow: "0 0 8px var(--accent)",
          }} />
          <span style={{ color: "var(--accent)", fontSize: "11px", letterSpacing: "0.1em", fontWeight: 600 }}>
            SCANNING IN PROGRESS
          </span>
        </div>
        <span style={{
          color: "var(--text-2)", fontSize: "13px", fontWeight: 700,
          fontFamily: "var(--mono)", letterSpacing: "0.05em",
        }}>
          ⏱ {fmtElapsed(elapsed)}
        </span>
      </div>

      {/* Stages */}
      <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column", gap: "0px" }}>
        {SCAN_STAGES.map((stage, i) => {
          const started = elapsed >= stage.startAfter;
          const done = started && elapsed >= stage.doneAfter;
          const state = done ? "done" : started ? "running" : "pending";
          const isLlm = stage.id === "llm";

          // LLM indeterminate progress bar progress
          const llmElapsed = Math.max(0, elapsed - stage.startAfter);
          const llmPct = isLlm && started ? Math.min((llmElapsed / llmEstimate) * 100, 94) : 0;

          return (
            <div key={stage.id} style={{
              display: "flex", alignItems: "center", gap: "10px",
              padding: "8px 0",
              borderBottom: i < SCAN_STAGES.length - 1 ? "1px solid var(--border)" : "none",
              opacity: state === "pending" ? 0.4 : 1,
              transition: "opacity 0.4s ease",
            }}>
              <StageIcon state={state} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isLlm && started && !done ? "5px" : 0 }}>
                  <span style={{
                    color: state === "done" ? "var(--text-2)" : state === "running" ? "var(--text)" : "var(--text-3)",
                    fontSize: "12px",
                    transition: "color 0.3s",
                  }}>
                    {stage.label}
                  </span>
                  <span style={{ color: "var(--text-3)", fontSize: "10px", flexShrink: 0, marginLeft: "12px" }}>
                    {stage.tool}
                  </span>
                </div>
                {/* LLM gets an indeterminate progress bar */}
                {isLlm && started && !done && (
                  <div style={{
                    position: "relative", height: "3px",
                    background: "var(--bg-4)", borderRadius: "2px",
                    overflow: "hidden",
                  }}>
                    {/* Determinate portion (estimated progress) */}
                    <div style={{
                      position: "absolute", top: 0, left: 0,
                      width: `${llmPct}%`, height: "100%",
                      background: "rgba(240,165,0,0.3)",
                      borderRadius: "2px",
                      transition: "width 1s linear",
                    }} />
                    {/* Shimmer overlay */}
                    <div style={{
                      position: "absolute", top: 0, left: 0,
                      width: "30%", height: "100%",
                      background: "linear-gradient(90deg, transparent, var(--accent), transparent)",
                      animation: "scanSweep 2.2s ease-in-out infinite",
                      borderRadius: "2px",
                    }} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── DonutChart ───────────────────────────────────────────────────────────────

function DonutChart({ counts }) {
  const total = totalFindings(counts);
  const r = 15.9155;

  if (!total) {
    return (
      <svg viewBox="0 0 36 36" style={{ width: "100%", maxWidth: 160 }}>
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--border)" strokeWidth="3.5" />
        <circle cx="18" cy="18" r="11.5" fill="var(--bg-2)" />
        <text x="18" y="16" textAnchor="middle" fill="var(--text-3)" fontSize="3.5" fontFamily="JetBrains Mono">NO</text>
        <text x="18" y="21" textAnchor="middle" fill="var(--text-3)" fontSize="3.5" fontFamily="JetBrains Mono">DATA</text>
      </svg>
    );
  }

  let accumulated = 0;
  const segments = SEV_ORDER.map((sev) => {
    const count = counts?.[sev] || 0;
    const pct = (count / total) * 100;
    const seg = { sev, pct, offset: 25 - accumulated, color: SEV_COLOR[sev].fg };
    accumulated += pct;
    return seg;
  }).filter((s) => s.pct > 0);

  return (
    <svg viewBox="0 0 36 36" style={{ width: "100%", maxWidth: 160 }}>
      {segments.map(({ sev, pct, offset, color }) => (
        <circle
          key={sev}
          cx="18" cy="18" r={r}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeDasharray={`${pct} ${100 - pct}`}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      ))}
      <circle cx="18" cy="18" r="11.5" fill="var(--bg-2)" />
      <text x="18" y="16.5" textAnchor="middle" fill="var(--text)" fontSize="5" fontFamily="JetBrains Mono" fontWeight="700">
        {total}
      </text>
      <text x="18" y="21.5" textAnchor="middle" fill="var(--text-3)" fontSize="2.8" fontFamily="JetBrains Mono" letterSpacing="0.3">
        TOTAL
      </text>
    </svg>
  );
}

// ── CategoryBar ──────────────────────────────────────────────────────────────

function CategoryBar({ label, count, max, color }) {
  const pct = max > 0 ? Math.max((count / max) * 100, count > 0 ? 4 : 0) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "5px 0" }}>
      <span style={{ width: 90, color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.08em", flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "4px", background: "var(--bg-4)", borderRadius: "2px", overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: color, borderRadius: "2px",
          transition: "width 0.6s ease",
        }} />
      </div>
      <span style={{ width: 24, textAlign: "right", color: count > 0 ? "var(--text)" : "var(--text-3)", fontSize: "11px", flexShrink: 0 }}>
        {count}
      </span>
    </div>
  );
}

// ── SevBadge ─────────────────────────────────────────────────────────────────

function SevBadge({ severity }) {
  const c = SEV_COLOR[severity] || SEV_COLOR.info;
  return (
    <span style={{
      display: "inline-block", padding: "1px 6px",
      borderRadius: "var(--radius)",
      background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
      fontSize: "10px", letterSpacing: "0.08em", fontWeight: 600, whiteSpace: "nowrap",
    }}>
      {severity.toUpperCase()}
    </span>
  );
}

// ── HealthBadge ───────────────────────────────────────────────────────────────

function HealthBadge({ health, size = "normal" }) {
  const s = HEALTH_STYLE[health] || { color: "var(--text-3)", label: "—", dot: "var(--text-3)" };
  const big = size === "large";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: big ? "8px" : "5px",
      color: s.color, fontSize: big ? "22px" : "11px",
      fontWeight: 700, letterSpacing: big ? "-0.01em" : "0.1em",
    }}>
      <span style={{
        width: big ? 10 : 7, height: big ? 10 : 7,
        borderRadius: "50%", background: s.dot, flexShrink: 0,
        boxShadow: `0 0 ${big ? 8 : 5}px ${s.dot}`,
      }} />
      {s.label}
    </span>
  );
}

// ── FindingRow ────────────────────────────────────────────────────────────────

function FindingRow({ f }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      borderBottom: "1px solid var(--border)",
      borderLeft: `3px solid ${SEV_COLOR[f.severity]?.fg || "var(--border-2)"}`,
    }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "grid",
          gridTemplateColumns: "90px 1fr 80px 120px",
          gap: "12px", padding: "10px 16px",
          cursor: "pointer", transition: "background 0.1s", alignItems: "center",
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-3)"}
        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
      >
        <SevBadge severity={f.severity} />
        <span style={{ color: "var(--text)", fontSize: "12px" }}>{f.title}</span>
        <span style={{
          color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.06em",
          textAlign: "center", padding: "1px 5px",
          border: "1px solid var(--border)", borderRadius: "var(--radius)",
        }}>
          {CAT_LABEL[f.category] || f.category}
        </span>
        <span style={{ color: "var(--text-3)", fontSize: "10px", fontFamily: "var(--mono)" }}>
          {f.file_path ? `${f.file_path}${f.line_start ? `:${f.line_start}` : ""}` : "—"}
        </span>
      </div>
      {open && (
        <div style={{ padding: "0 16px 14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {f.description && (
            <p style={{ color: "var(--text-2)", fontSize: "12px", lineHeight: 1.7, margin: 0 }}>
              {f.description}
            </p>
          )}
          {f.remediation && (
            <div style={{
              background: "rgba(63,185,80,0.05)", border: "1px solid rgba(63,185,80,0.2)",
              borderRadius: "var(--radius)", padding: "10px 12px",
            }}>
              <div style={{ color: "var(--green)", fontSize: "10px", letterSpacing: "0.08em", marginBottom: "5px" }}>REMEDIATION</div>
              <pre style={{ color: "var(--text-2)", fontSize: "11px", whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--mono)", lineHeight: 1.6 }}>
                {f.remediation}
              </pre>
            </div>
          )}
          {f.llm_reasoning && (
            <div style={{
              background: "var(--bg-4)", border: "1px solid var(--border)",
              borderRadius: "var(--radius)", padding: "10px 12px",
            }}>
              <div style={{ color: "var(--accent)", fontSize: "10px", letterSpacing: "0.08em", marginBottom: "5px" }}>LLM REASONING</div>
              <p style={{ color: "var(--text-2)", fontSize: "11px", lineHeight: 1.7, margin: 0 }}>{f.llm_reasoning}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ScanHistoryRow ────────────────────────────────────────────────────────────

function ScanHistoryRow({ scan, isSelected, onSelect }) {
  const total = totalFindings(scan.finding_counts);
  const cell = { padding: "8px 16px", fontSize: "11px" };
  return (
    <tr
      onClick={() => onSelect(scan)}
      style={{
        cursor: "pointer",
        background: isSelected ? "var(--bg-3)" : "transparent",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-3)"; }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
    >
      <td style={{ ...cell, color: "var(--text-2)", whiteSpace: "nowrap" }}>{relativeTime(scan.started_at)}</td>
      <td style={cell}>
        {scan.status === "running" ? (
          <span style={{ color: "var(--accent)", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "stagePulse 1s ease-in-out infinite", display: "inline-block" }} />
            RUNNING
          </span>
        ) : scan.status === "failed" ? (
          <span style={{ color: "var(--red)", fontSize: "11px" }}>FAILED</span>
        ) : scan.overall_health ? (
          <HealthBadge health={scan.overall_health} />
        ) : <span style={{ color: "var(--text-3)", fontSize: "11px" }}>—</span>}
      </td>
      <td style={{ ...cell, color: total > 0 ? "var(--text)" : "var(--text-3)", textAlign: "right" }}>
        {scan.status === "complete" ? total : "—"}
      </td>
      <td style={{ ...cell, color: "var(--text-3)", whiteSpace: "nowrap" }}>{scan.status === "complete" ? fmtDuration(scan) : "—"}</td>
      <td style={{ ...cell, color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.06em" }}>
        {scan.triggered_by === "manual"
          ? `manual${scan.triggered_by_user ? ` (${scan.triggered_by_user})` : ""}`
          : "scheduled"}
      </td>
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Health() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [status, setStatus] = useState(null);
  const [scans, setScans] = useState([]);
  const [findings, setFindings] = useState([]);
  const [selectedScan, setSelectedScan] = useState(null);
  const [catFilter, setCatFilter] = useState("all");
  const [scanningErr, setScanningErr] = useState(null);
  const [triggering, setTriggering] = useState(false);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [justTriggered, setJustTriggered] = useState(false);
  const pollRef = useRef(null);
  const elapsedRef = useRef(null);
  const triggerTimeRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const [s, sc] = await Promise.all([getHealthStatus(), listScans()]);
      setStatus(s);
      setScans(sc);
      if (!selectedScan) {
        const latest = sc.find((x) => x.status === "complete");
        if (latest) setSelectedScan(latest);
      }
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [selectedScan]);

  const isScanning = status?.running || justTriggered;

  // Poll while running (or right after triggering while waiting for first running=true)
  useEffect(() => { loadStatus(); }, []); // eslint-disable-line

  useEffect(() => {
    if (isScanning) {
      pollRef.current = setInterval(loadStatus, 2000);
    } else {
      clearInterval(pollRef.current);
    }
    return () => clearInterval(pollRef.current);
  }, [isScanning, loadStatus]);

  // Clear justTriggered once the backend confirms running
  useEffect(() => {
    if (status?.running) setJustTriggered(false);
  }, [status?.running]); // eslint-disable-line

  // Elapsed timer — ticks every second while scanning
  const runningScan = status?.running_scan_id
    ? scans.find((s) => s.id === status.running_scan_id)
    : null;

  useEffect(() => {
    if (!isScanning) {
      setElapsed(0);
      clearInterval(elapsedRef.current);
      triggerTimeRef.current = null;
      return;
    }
    // Use the DB started_at if available; fall back to when the button was clicked
    const startedAt = runningScan?.started_at
      ? new Date(runningScan.started_at).getTime()
      : (triggerTimeRef.current || Date.now());
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    elapsedRef.current = setInterval(tick, 1000);
    return () => clearInterval(elapsedRef.current);
  }, [isScanning, runningScan?.started_at]); // eslint-disable-line

  // Load findings when selected scan changes
  useEffect(() => {
    if (!selectedScan || selectedScan.status !== "complete") {
      setFindings([]);
      return;
    }
    getScanFindings(selectedScan.id).then(setFindings).catch(() => setFindings([]));
  }, [selectedScan]);

  const handleTrigger = async () => {
    if (!isAdmin || triggering || isScanning) return;
    setTriggering(true);
    setScanningErr(null);
    // Record click time so elapsed timer starts immediately, before first poll
    triggerTimeRef.current = Date.now();
    setJustTriggered(true);
    try {
      await triggerScan();
      await loadStatus();
    } catch (e) {
      setJustTriggered(false);
      triggerTimeRef.current = null;
      setScanningErr(e?.response?.data?.detail || "Failed to start scan");
    } finally {
      setTriggering(false);
    }
  };

  const handleSelectScan = (scan) => {
    setSelectedScan(scan);
    setCatFilter("all");
  };

  const scanCounts = selectedScan?.finding_counts || {};
  const catCounts = findings.reduce((acc, f) => { acc[f.category] = (acc[f.category] || 0) + 1; return acc; }, {});
  const maxCat = Math.max(...Object.values(catCounts), 1);
  const filtered = catFilter === "all" ? findings : findings.filter((f) => f.category === catFilter);
  const latestScan = status?.latest_scan;
  const healthStyle = HEALTH_STYLE[latestScan?.overall_health] || { color: "var(--text-3)", label: "NO DATA", dot: "var(--text-3)" };

  const thStyle = {
    padding: "8px 16px", fontSize: "10px", letterSpacing: "0.08em",
    color: "var(--text-3)", fontWeight: 500, fontFamily: "var(--mono)",
    borderBottom: "1px solid var(--border)",
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 24px" }}>

      {/* ── Top shimmer bar (only while scanning) ── */}
      {isScanning && <ScanProgressBar />}

      {/* ── Header ── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        marginBottom: "24px",
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "15px", fontWeight: 700, letterSpacing: "0.08em", color: "var(--text)", marginBottom: "6px" }}>
            SYSTEM HEALTH
          </h1>
          <div style={{ color: "var(--text-3)", fontSize: "11px" }}>
            {latestScan
              ? <>Last scan: <span style={{ color: "var(--text-2)" }}>{relativeTime(latestScan.started_at)}</span></>
              : "No scans yet"}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
          {isAdmin && (
            <button
              onClick={handleTrigger}
              disabled={triggering || isScanning}
              style={{
                padding: "7px 16px",
                background: (triggering || isScanning) ? "var(--bg-3)" : "var(--accent-dim)",
                border: `1px solid ${(triggering || isScanning) ? "var(--border)" : "var(--accent)"}`,
                color: (triggering || isScanning) ? "var(--text-3)" : "var(--accent)",
                borderRadius: "var(--radius)", cursor: (triggering || isScanning) ? "not-allowed" : "pointer",
                fontSize: "11px", letterSpacing: "0.08em", fontFamily: "var(--mono)",
                transition: "all 0.15s",
              }}
            >
              {triggering ? "STARTING…" : isScanning ? "RUNNING…" : "↻ SCAN NOW"}
            </button>
          )}
          {scanningErr && <span style={{ fontSize: "11px", color: "var(--red)" }}>{scanningErr}</span>}
        </div>
      </div>

      {/* ── Scan stages panel (while running) ── */}
      {isScanning && <ScanStagesPanel elapsed={elapsed} />}

      {/* ── Status banner (last completed scan) ── */}
      {latestScan && (
        <div style={{
          display: "flex", alignItems: "center", gap: "16px",
          padding: "14px 20px",
          background: `linear-gradient(135deg, ${healthStyle.dot}0a 0%, var(--bg-2) 100%)`,
          border: `1px solid ${healthStyle.dot}33`,
          borderRadius: "var(--radius-lg)",
          marginBottom: "24px",
        }}>
          <HealthBadge health={latestScan.overall_health} size="large" />
          <div style={{ width: "1px", height: "32px", background: "var(--border)" }} />
          <div style={{ display: "flex", gap: "28px" }}>
            {SEV_ORDER.map((sev) => {
              const count = latestScan.finding_counts?.[sev] || 0;
              const c = SEV_COLOR[sev];
              return (
                <div key={sev} style={{ textAlign: "center" }}>
                  <div style={{ color: count > 0 ? c.fg : "var(--text-3)", fontSize: "18px", fontWeight: 700, lineHeight: 1.2 }}>{count}</div>
                  <div style={{ color: "var(--text-3)", fontSize: "9px", letterSpacing: "0.1em", marginTop: "2px" }}>{sev.toUpperCase()}</div>
                </div>
              );
            })}
            <div style={{ textAlign: "center" }}>
              <div style={{ color: (latestScan.config_issue_count || 0) > 0 ? "var(--orange)" : "var(--text-3)", fontSize: "18px", fontWeight: 700, lineHeight: 1.2 }}>
                {latestScan.config_issue_count || 0}
              </div>
              <div style={{ color: "var(--text-3)", fontSize: "9px", letterSpacing: "0.1em", marginTop: "2px" }}>CONFIG</div>
            </div>
          </div>
        </div>
      )}

      {!latestScan && !loading && !isScanning && (
        <div style={{
          padding: "40px", textAlign: "center",
          border: "1px dashed var(--border)", borderRadius: "var(--radius-lg)",
          color: "var(--text-3)", fontSize: "12px", letterSpacing: "0.08em",
          marginBottom: "24px",
        }}>
          {isAdmin
            ? "No scans yet — click ↻ SCAN NOW to run the first self-assessment."
            : "No scans have been run yet. Ask an admin to trigger a scan."}
        </div>
      )}

      {/* ── Charts row ── */}
      {selectedScan?.status === "complete" && (
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "16px", marginBottom: "24px" }}>
          <div style={{
            background: "var(--bg-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)", padding: "20px 16px",
            display: "flex", flexDirection: "column", alignItems: "center", gap: "12px",
          }}>
            <div style={{ color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.1em" }}>BY SEVERITY</div>
            <DonutChart counts={scanCounts} />
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "4px" }}>
              {SEV_ORDER.map((sev) => {
                const count = scanCounts[sev] || 0;
                return count > 0 ? (
                  <div key={sev} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "10px" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: SEV_COLOR[sev].fg, flexShrink: 0 }} />
                    <span style={{ color: "var(--text-3)", flex: 1 }}>{sev}</span>
                    <span style={{ color: "var(--text-2)" }}>{count}</span>
                  </div>
                ) : null;
              })}
            </div>
          </div>

          <div style={{
            background: "var(--bg-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)", padding: "20px 24px",
          }}>
            <div style={{ color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.1em", marginBottom: "16px" }}>BY CATEGORY</div>
            {CATEGORY_ORDER.map((cat) => {
              const count = catCounts[cat] || 0;
              const color = cat === "config" ? "#e3650a" : cat === "secrets" ? "#f85149"
                : cat === "llm" ? "#bc8cff" : cat === "dependencies" ? "#d29922" : "#388bfd";
              return <CategoryBar key={cat} label={CAT_LABEL[cat]} count={count} max={maxCat} color={color} />;
            })}
          </div>
        </div>
      )}

      {/* ── Scan history ── */}
      <div style={{
        background: "var(--bg-2)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", marginBottom: "24px", overflow: "hidden",
      }}>
        <div style={{
          padding: "12px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span style={{ color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.1em" }}>SCAN HISTORY</span>
          <span style={{ color: "var(--text-3)", fontSize: "10px" }}>{scans.length} scan{scans.length !== 1 ? "s" : ""}</span>
        </div>
        {scans.length === 0 ? (
          <div style={{ padding: "24px", color: "var(--text-3)", fontSize: "12px", textAlign: "center" }}>No scans yet</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["TIME", "HEALTH", "FINDINGS", "DURATION", "TRIGGERED BY"].map((h) => (
                  <th key={h} style={{ ...thStyle, textAlign: h === "FINDINGS" ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scans.map((scan) => (
                <ScanHistoryRow
                  key={scan.id}
                  scan={scan}
                  isSelected={selectedScan?.id === scan.id}
                  onSelect={handleSelectScan}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Findings ── */}
      {selectedScan?.status === "complete" && (
        <div style={{
          background: "var(--bg-2)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)", overflow: "hidden",
        }}>
          <div style={{
            padding: "12px 16px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
          }}>
            <span style={{ color: "var(--text-3)", fontSize: "10px", letterSpacing: "0.1em" }}>
              FINDINGS — {relativeTime(selectedScan.started_at)}
            </span>
            <div style={{ display: "flex", gap: "6px", marginLeft: "auto" }}>
              {["all", ...CATEGORY_ORDER].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCatFilter(cat)}
                  style={{
                    padding: "3px 9px",
                    background: catFilter === cat ? "var(--accent-dim)" : "transparent",
                    border: `1px solid ${catFilter === cat ? "var(--accent)" : "var(--border)"}`,
                    color: catFilter === cat ? "var(--accent)" : "var(--text-3)",
                    borderRadius: "var(--radius)", cursor: "pointer",
                    fontSize: "10px", letterSpacing: "0.06em",
                    fontFamily: "var(--mono)", transition: "all 0.1s",
                  }}
                >
                  {cat === "all" ? "ALL" : CAT_LABEL[cat]}
                </button>
              ))}
            </div>
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: "24px", color: "var(--text-3)", fontSize: "12px", textAlign: "center" }}>No findings in this category</div>
          ) : (
            filtered.map((f) => <FindingRow key={f.id} f={f} />)
          )}
        </div>
      )}

      <style>{`
        @keyframes scanSweep {
          0%   { transform: translateX(-200%); }
          100% { transform: translateX(400%); }
        }
        @keyframes stagePulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.5; transform: scale(0.85); }
        }
      `}</style>
    </div>
  );
}
