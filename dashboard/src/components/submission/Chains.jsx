// Attack chains on the run page: the LLM's estimate of how findings combine.
// Live/broken state comes from the current decisions, so it updates as you triage.
import React from "react";
import { SevPill } from "./FindingDetail.jsx";
import Markdown from "../Markdown.jsx";
import { sevVar } from "../queue/Board.jsx";

const BLOCKING = new Set(["critical", "high"]);

/** Chains with their findings resolved; `broken` when a step was dismissed or no longer exists. */
export function resolveChains(chains, findings) {
  const byId = new Map(findings.map((f, i) => [f.id, { f, ref: `F${i + 1}` }]));
  return (chains || []).map((c) => {
    const steps = c.steps.map((s) => ({ ...s, ...(byId.get(s.finding_id) || {}) }));
    const broken = steps.filter((s) => !s.f || s.f.disposition === "false_positive");
    return { ...c, steps, broken, live: broken.length === 0 };
  });
}

/** Findings that a live critical/high chain still needs decided before sign-off. */
export function chainGatePending(resolved) {
  const ids = new Set();
  resolved.filter((c) => c.live && BLOCKING.has(c.severity))
    .forEach((c) => c.steps.forEach((s) => { if (!s.f.disposition) ids.add(s.f.id); }));
  return ids;
}

export default function Chains({ resolved, selected, onSelect, analyzed }) {
  return (
    <section className="panel panel-b chains">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: ".7rem" }}>
        <span className="panel-t" style={{ margin: 0 }}>Attack chains</span>
        <span className="est" title="Estimated by the LLM from this run's findings">LLM estimate</span>
        {resolved.length > 0 && <span className="muted" style={{ marginLeft: "auto", fontSize: ".78rem" }}>{resolved.length}</span>}
      </div>
      {resolved.length === 0 ? (
        <div className="muted" style={{ fontSize: ".84rem" }}>
          {analyzed ? "No chains: these findings don't combine into a bigger attack." : "Not analysed for this run."}
        </div>
      ) : resolved.map((c) => {
        const brk = c.steps[Math.min(c.break_index, c.steps.length - 1)];
        const on = selected === c.id;
        return (
          <div key={c.id} className={`chain ${on ? "on" : ""} ${c.live ? "" : "broken"}`} role="button" tabIndex={0}
            aria-expanded={on} onClick={() => onSelect(on ? null : c.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(on ? null : c.id))}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <SevPill sev={c.live ? c.severity : "info"} />
              <span className="muted" style={{ fontSize: ".74rem" }}>{c.confidence} confidence</span>
            </div>
            <div className="ct">{c.title}</div>
            <div className="path">
              {c.steps.map((s, j) => (
                <React.Fragment key={j}>
                  {j > 0 && <span className="arr">→</span>}
                  <span className={`ref ${s.f ? sevVar(s.f.severity) : ""} ${!s.f || s.f.disposition === "false_positive" ? "fp" : ""}`}
                    title={s.f ? s.f.title : "This finding is no longer in the run"}>{s.ref || "gone"}</span>
                </React.Fragment>
              ))}
            </div>
            {c.live ? (
              brk?.f && <div className="brk">Break it: fix <b>{brk.ref}</b> · {brk.f.title}</div>
            ) : (
              <div className="brk">Broken: <b style={{ color: "var(--text2)" }}>{c.broken.map((s) => s.ref || "a removed finding").join(", ")}</b>
                {" "}{c.broken.some((s) => s.f) ? "marked false positive" : "no longer in this run"}</div>
            )}
            {on && (
              <>
                {c.narrative && <Markdown text={c.narrative} className="narr" />}
                <div className="steps">
                  {c.steps.map((s, j) => (
                    <div key={j} className="step"><span className="role">{s.role}</span>
                      <span><b style={{ color: "var(--text)", fontWeight: 500 }}>{s.ref || "—"}</b> {s.why}</span></div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
      {resolved.length > 0 && (
        <div className="muted" style={{ fontSize: ".74rem", marginTop: 10 }}>
          Click a chain to highlight its findings. Severities aren&rsquo;t changed; live critical and high chains need
          every step decided before sign-off.
        </div>
      )}
    </section>
  );
}
