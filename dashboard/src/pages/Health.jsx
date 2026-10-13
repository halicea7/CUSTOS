import React, { useEffect, useRef, useState } from "react";
import { useHealthServices, useHealthStatus, useScanFindings, useScans, useTriggerScan } from "../api/queries.js";
import { errorMessage } from "../api/errors.js";
import { ago, sevVar } from "../components/queue/Board.jsx";
import { SEV_LABEL, SevPill, findingLoc, sourceLabel } from "../components/submission/FindingDetail.jsx";
import { useToast } from "../components/Toast.jsx";

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const CATEGORIES = [["sast", "SAST"], ["secrets", "Secrets"], ["dependencies", "Dependencies"], ["config", "Config"], ["llm", "LLM"]];
const HEALTH = { healthy: ["Healthy", "ok"], warning: ["Warning", "high"], urgent: ["Urgent", "crit"] };
const SVC_COLOR = { ok: "var(--ok)", warn: "var(--high)", down: "var(--crit)", off: "var(--text3)" };
const STAGE_ICON = {
  done: <span style={{ color: "var(--ok)" }}>✓</span>,
  failed: <span style={{ color: "var(--crit)" }}>✕</span>,
  running: <span className="spin" style={{ color: "var(--accent)" }} />,
  skipped: <span className="muted">–</span>,
  pending: <span className="muted">○</span>,
};
const STAGE_WORD = { done: "done", failed: "failed", running: "running…", skipped: "skipped", pending: "waiting" };
const total = (c) => Object.values(c || {}).reduce((a, v) => a + v, 0);
const plural = (k, w) => `${k} ${w}${k !== 1 ? "s" : ""}`;

function duration(scan) {
  if (!scan.started_at || !scan.finished_at) return null;
  const s = Math.round((new Date(scan.finished_at) - new Date(scan.started_at)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function HealthBadge({ health }) {
  const [label, k] = HEALTH[health] || ["No data", "info"];
  return <span className="badge" style={{ color: `var(--${k})`, background: `var(--${k}-bg)` }}>{label.toUpperCase()}</span>;
}

function Services() {
  const { data, error, isPending, dataUpdatedAt } = useHealthServices();
  return (
    <section className="panel" style={{ marginBottom: "var(--gap)" }}>
      <div className="panel-h">
        <h2>Services</h2>
        <span className="muted" style={{ fontSize: ".8rem" }}>
          {dataUpdatedAt ? `checked ${ago(dataUpdatedAt)} · every 30s` : ""}
        </span>
      </div>
      <div className="panel-b">
        {error ? <div className="result bad">{errorMessage(error, "Couldn't check the services")}</div>
          : isPending ? <div className="muted">Checking…</div> : (
            <div className="svc">
              {data.services.map((s) => (
                <div key={s.name} className={s.state}>
                  <span className={`dot ${s.state === "down" ? "pulse" : ""}`} style={{ background: SVC_COLOR[s.state] }} />
                  <span style={{ minWidth: 0 }}><b>{s.name}</b><small>{s.detail}</small></span>
                </div>
              ))}
            </div>
          )}
      </div>
    </section>
  );
}

function Stages({ stages, running, elapsed, latest }) {
  return (
    <section className="panel" style={{ marginBottom: "var(--gap)" }}>
      <div className="panel-h">
        <h2>Self-check</h2>
        <span className="muted" style={{ fontSize: ".85rem" }}>
          {running ? <span style={{ color: "var(--accent)" }}>running · {clock(elapsed)}</span>
            : latest ? `last run ${ago(latest.started_at)}${duration(latest) ? ` · took ${duration(latest)}` : ""}` : "never run"}
        </span>
      </div>
      <div className="panel-b">
        {stages ? (
          <div className="stages" role="list" aria-label="Scan stages">
            {stages.map((s) => (
              <div key={s.id} role="listitem" className={`stage ${s.state}`} title={s.detail || s.tool}
                aria-label={`${s.label}: ${s.state}`}>
                <div className="nm">{STAGE_ICON[s.state] || STAGE_ICON.pending}{s.label}</div>
                <div className="st">{s.detail || STAGE_WORD[s.state] || s.state}</div>
                <div className="prog"><span style={{ width: s.state === "pending" ? 0 : "100%" }} /></div>
              </div>
            ))}
          </div>
        ) : running ? (
          <div className="muted">
            Waiting for the worker to start the scan…
            {elapsed >= 30 && (
              <div style={{ marginTop: 6, color: "var(--high)" }}>
                No worker has picked this scan up yet. Check that the Custos worker is running and up to date;
                scans no worker runs are marked failed after an hour.
              </div>
            )}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: ".88rem" }}>
            Custos scans its own code with the same tools it runs on your repositories.
            {latest && " Per-stage details are kept for three hours after a run."}
          </div>
        )}
      </div>
    </section>
  );
}

function FindingRow({ f }) {
  const [open, setOpen] = useState(false);
  const hasMore = f.description || f.remediation || f.llm_reasoning;
  return (
    <>
      <div className="frow nocheck" style={{ "--sev": `var(--${sevVar(f.severity)})`, cursor: hasMore ? "pointer" : "default" }}
        onClick={() => hasMore && setOpen((v) => !v)} aria-expanded={hasMore ? open : undefined}>
        <SevPill sev={f.severity} />
        <div style={{ minWidth: 0 }}>
          <div className="ttl" title={f.title}>{f.title}</div>
          <div className="fsub">
            {f.file_path && <span className="path">{findingLoc(f)}</span>}
            {f.cwe && <span>{f.cwe}</span>}
          </div>
        </div>
        <span className="src">{sourceLabel(f.source)}</span>
      </div>
      {open && (
        <div className="db" style={{ paddingTop: 0, borderTop: 0 }}>
          {f.description && <div><h3>Description</h3><p>{f.description}</p></div>}
          {f.llm_reasoning && <div><h3>LLM analysis</h3><p>{f.llm_reasoning}</p></div>}
          {f.remediation && <div><h3>Recommended fix</h3><p className="mono" style={{ fontSize: ".84rem" }}>{f.remediation}</p></div>}
        </div>
      )}
    </>
  );
}

function Donut({ counts }) {
  const tot = total(counts);
  const C = 2 * Math.PI * 48;
  let off = 0;
  return (
    <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
      <svg className="donut" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="48" stroke="var(--raised2)" />
        {SEV_ORDER.map((s) => {
          const seg = tot ? ((counts[s] || 0) / tot) * C : 0;
          const el = seg ? <circle key={s} cx="60" cy="60" r="48" stroke={`var(--${sevVar(s)})`}
            strokeDasharray={`${seg} ${C - seg}`} strokeDashoffset={-off} /> : null;
          off += seg;
          return el;
        })}
      </svg>
      <div className="bars" style={{ flex: 1 }}>
        {SEV_ORDER.map((s) => (
          <div key={s} className="bar-row" style={{ gridTemplateColumns: "4.2rem 1fr" }}>
            <span>{SEV_LABEL[s]}</span>
            <span className="mono" style={{ color: counts[s] ? `var(--${sevVar(s)})` : "var(--text3)" }}>{counts[s] || 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Health() {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState(null);
  const [cat, setCat] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [justTriggered, setJustTriggered] = useState(false);
  const triggeredAt = useRef(null);

  // Poll only while a scan is running (or right after starting one, until the API says so).
  const [polling, setPolling] = useState(false);
  const { data: status } = useHealthStatus(polling);
  const { data: scans = [], isPending } = useScans(polling);
  const running = Boolean(status?.running) || justTriggered;
  useEffect(() => { setPolling(running); }, [running]);
  useEffect(() => { if (status?.running) setJustTriggered(false); }, [status?.running]);

  // Say when a scan we watched finishes.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && status && !status.running) {
      const s = status.latest_scan;
      toast(s ? `Self-check finished: ${plural(total(s.finding_counts), "finding")}` : "Self-check finished");
      setSelectedId(null);
    }
    wasRunning.current = Boolean(status?.running);
  }, [status?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = scans.find((x) => x.id === selectedId) || scans.find((x) => x.status === "complete") || null;
  const { data: findings = [] } = useScanFindings(selected);
  const trigger = useTriggerScan();

  const startedAt = status?.running_started_at;
  useEffect(() => {
    if (!running) { setElapsed(0); triggeredAt.current = null; return undefined; }
    const from = startedAt ? new Date(startedAt).getTime() : (triggeredAt.current || Date.now());
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - from) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  const start = () => {
    if (trigger.isPending || running) return;
    triggeredAt.current = Date.now();
    setJustTriggered(true);
    trigger.mutate(undefined, {
      onError: (e) => {
        setJustTriggered(false); triggeredAt.current = null;
        toast(errorMessage(e, "Couldn't start the self-check"), { bad: true });
      },
    });
  };

  const latest = status?.latest_scan;
  const stages = running ? status?.running_stages : status?.latest_stages;
  const counts = selected?.finding_counts || {};
  const catCounts = findings.reduce((a, f) => ({ ...a, [f.category]: (a[f.category] || 0) + 1 }), {});
  const shown = (cat ? findings.filter((f) => f.category === cat) : findings)
    .slice().sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));

  return (
    <div className="page glow">
      <div className="top">
        <div>
          <h1>Health</h1>
          <div className="subt">Custos scans its own code and checks its services</div>
        </div>
        <div className="tools">
          <button className="btn primary" onClick={start} disabled={trigger.isPending || running}>
            {running ? <><span className="spin" /> Scanning</> : "▶ Run self-check"}
          </button>
        </div>
      </div>

      <Services />
      <Stages stages={stages} running={running} elapsed={elapsed} latest={latest} />

      {selected?.error && (
        <div className={`banner ${selected.status === "failed" ? "bad" : "note"}`}>
          <b>{selected.status === "failed" ? "Self-check failed: " : "Note: "}</b>{selected.error}
        </div>
      )}

      <div className="cols">
        <section className="panel">
          <div className="panel-h">
            <h2>{selected && selected.id !== latest?.id ? `Findings · ${ago(selected.started_at)}` : "Latest findings"}</h2>
            {selected?.overall_health && <HealthBadge health={selected.overall_health} />}
            {findings.length > 0 && (
              <div className="chips" style={{ marginLeft: "auto" }}>
                <button className={`chip ${!cat ? "on" : ""}`} onClick={() => setCat(null)}>All</button>
                {CATEGORIES.filter(([k]) => catCounts[k]).map(([k, l]) => (
                  <button key={k} className={`chip ${cat === k ? "on" : ""}`} onClick={() => setCat(k)}>
                    {l}<span className="n">{catCounts[k]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {isPending ? <div className="empty">Loading…</div>
            : !selected ? <div className="empty">No self-checks yet. Run one to see how Custos itself is doing.</div>
              : selected.status !== "complete" ? <div className="empty">This self-check didn&rsquo;t finish, so it has no findings.</div>
                : shown.length === 0 ? <div className="empty">{findings.length ? "Nothing in this category." : "No findings: Custos looks clean."}</div>
                  : <div className="flist">{shown.map((f) => <FindingRow key={f.id} f={f} />)}</div>}
        </section>

        <div className="side">
          {selected?.status === "complete" && (
            <section className="panel panel-b">
              <div className="panel-t">By severity</div>
              <Donut counts={counts} />
              {selected.config_issue_count > 0 && (
                <div className="muted" style={{ fontSize: ".82rem", marginTop: 10 }}>
                  including {plural(selected.config_issue_count, "configuration issue")}
                </div>
              )}
            </section>
          )}
          <section className="panel">
            <div className="panel-h"><h2>History</h2><span className="aside">{plural(scans.length, "run")}</span></div>
            {scans.length === 0 && <div className="empty">No runs yet.</div>}
            {scans.map((s) => (
              <div key={s.id} className="ev" role="button" tabIndex={0}
                style={{ gridTemplateColumns: "auto 1fr auto", background: selected?.id === s.id ? "var(--raised)" : undefined }}
                onClick={() => { setSelectedId(s.id); setCat(null); }}
                onKeyDown={(e) => e.key === "Enter" && setSelectedId(s.id)}
                title={duration(s) ? `Took ${duration(s)}` : undefined}>
                {s.status === "running" ? <span className="badge" style={{ color: "var(--accent)", background: "var(--accent-bg)" }}>RUNNING</span>
                  : s.status === "failed" ? <span className="badge" style={{ color: "var(--crit)", background: "var(--crit-bg)" }}>FAILED</span>
                    : <HealthBadge health={s.overall_health} />}
                <span>
                  {s.status === "complete" ? plural(total(s.finding_counts), "finding") : s.status}
                  {" · "}{s.triggered_by === "manual" ? s.triggered_by_user || "manual" : "scheduled"}
                </span>
                <time>{ago(s.started_at)}</time>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
