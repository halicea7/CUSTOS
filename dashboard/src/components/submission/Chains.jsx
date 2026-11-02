// Attack chains on the run page: the LLM's estimate of how findings combine.
// Live/broken state comes from the current decisions, so it updates as you triage.
import React, { useState } from "react";
import { SevPill } from "./FindingDetail.jsx";
import Markdown from "../Markdown.jsx";
import { sevVar } from "../queue/Board.jsx";
import { useChainPoc, useClearChainPoc, useGenerateChainPoc } from "../../api/queries.js";
import { errorMessage } from "../../api/errors.js";
import { useToast } from "../Toast.jsx";
import { useTheme } from "../../App.jsx";
import { Modal } from "../ui.jsx";

const BLOCKING = new Set(["critical", "high"]);

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return <button className="btn sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>;
}

function fmtWhen(ts) {
  return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

/** The PoC's content, inside the modal: warning, preconditions, each step, impact, caveats. */
function PocBody({ data }) {
  return (
    <div className="poc-body">
      <div className="banner bad" style={{ margin: 0 }}>
        <b>For authorized testing only, by this team, on infrastructure you own and control.</b> Prefer an
        isolated clone over production; during an active incident, run nothing here without your IR
        process&rsquo;s sign-off. Custos never runs any of this — you decide whether, where and when.
      </div>
      {data.summary && <p className="narr" style={{ fontSize: ".92rem" }}>{data.summary}</p>}
      {data.preconditions && <div className="poc-note"><h4>Preconditions</h4><p>{data.preconditions}</p></div>}
      {data.steps.map((s, i) => (
        <div key={i} className="poc-step">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
            <b>{s.label}</b><span className="muted" style={{ fontSize: ".8rem" }}>{s.action}</span>
          </div>
          <div style={{ position: "relative" }}>
            <pre className="poc-commands">{s.commands}</pre>
            <div style={{ position: "absolute", top: 6, right: 6 }}><CopyButton text={s.commands} /></div>
          </div>
          <div className="muted" style={{ fontSize: ".8rem" }}>Expect: {s.expected_result}</div>
        </div>
      ))}
      {data.impact && <div className="poc-note"><h4>Impact if it all succeeds</h4><p>{data.impact}</p></div>}
      {data.caveats && <div className="poc-note"><h4>Caveats</h4><p>{data.caveats}</p></div>}
      <div className="muted" style={{ fontSize: ".76rem" }}>
        Written by <span className="mono">{data.model}</span> from this run&rsquo;s findings; verify each step
        against the real code before relying on it.
      </div>
    </div>
  );
}

/** Admin-only: generate, view and clear one chain's exploitation PoC, in a centered modal
 * with room for it — the inline chain card is too narrow for commands and a warning banner.
 *
 * Custos never runs anything here itself — it only writes out text for an
 * admin to read, judge, and run by hand, in an environment they control. */
function ChainPoc({ submissionId, chain }) {
  const { theme } = useTheme();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const generate = useGenerateChainPoc(submissionId);
  const clear = useClearChainPoc(submissionId);
  // Only read the stored PoC when we're not already showing a fresher one from
  // a mutation this session — avoids a GET racing the POST that just wrote it.
  const queryEnabled = open && chain.has_poc && !generate.isPending && !generate.data;
  const { data: stored, isLoading, isError, error } = useChainPoc(submissionId, chain.id, queryEnabled);
  const stop = (e) => e.stopPropagation();
  const notFound = isError && error?.response?.status === 404;

  const data = generate.isPending ? null : generate.data || stored;
  const loading = generate.isPending || (!generate.data && isLoading);
  const loadError = generate.isPending ? null : generate.error || (!generate.data && isError && !notFound ? error : null);

  const doGenerate = (e) => {
    stop(e);
    setOpen(true);
    generate.mutate(chain.id, { onError: (err) => toast(errorMessage(err, "Couldn't generate a PoC"), "bad") });
  };
  const doClear = (e) => {
    stop(e);
    clear.mutate(chain.id, { onSuccess: () => setOpen(false) });
  };

  return (
    <div className="chain-poc" onClick={stop}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {!chain.has_poc ? (
          <button className="btn sm" disabled={!chain.live || generate.isPending} onClick={doGenerate}
            title={!chain.live ? "Only a live chain can be verified" : "Writes concrete steps to confirm this chain by hand; nothing runs automatically"}>
            {generate.isPending ? <><span className="spin" /> Generating…</> : "⚠ Generate exploitation PoC"}
          </button>
        ) : (
          <>
            <button className="btn sm" onClick={(e) => { stop(e); setOpen(true); }}>View PoC</button>
            <button className="btn sm" disabled={generate.isPending} onClick={doGenerate}>
              {generate.isPending ? <><span className="spin" /> Regenerating…</> : "Regenerate"}
            </button>
            <button className="btn sm danger" disabled={clear.isPending} onClick={doClear}>Clear</button>
            <span className="muted" style={{ fontSize: ".72rem" }}>
              verified by {chain.poc_generated_by} · {fmtWhen(chain.poc_generated_at)}
            </span>
          </>
        )}
      </div>

      {open && (
        <Modal theme={theme} title="Exploitation PoC" subtitle={chain.title} width={820} onClose={() => setOpen(false)}>
          {loading && <div className="muted"><span className="spin" /> {generate.isPending ? "Writing the PoC…" : "Loading…"}</div>}
          {loadError && <div className="result bad">{errorMessage(loadError, "Couldn't load the PoC")}</div>}
          {!loading && data && <PocBody data={data} />}
        </Modal>
      )}
    </div>
  );
}

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

// analysis: the latest chain pass ({status, note, model, ...}) or null if it never ran for this run.
function EmptyState({ analysis, enabled }) {
  if (!analysis) {
    return (
      <div className="muted" style={{ fontSize: ".84rem" }}>
        {enabled ? "Not analysed yet: this run was scanned before chain analysis ran, or its LLM review failed. Re-run the LLM to analyse it."
          : "Chain analysis is turned off in Settings → Analysis."}
      </div>
    );
  }
  if (analysis.status === "failed") {
    return <div className="result bad" style={{ display: "block", fontSize: ".8rem" }}>Analysis failed: {analysis.note}</div>;
  }
  if (analysis.status === "running") return <div className="muted"><span className="spin" /> Analysing…</div>;
  return (
    <div className="muted" style={{ fontSize: ".84rem" }}>
      No chains found by <span className="mono">{analysis.model}</span>.
      {analysis.note && <div style={{ marginTop: 4, fontSize: ".78rem" }}>{analysis.note}</div>}
    </div>
  );
}

export default function Chains({ resolved, selected, onSelect, analysis, enabled, submissionId, isAdmin }) {
  return (
    <section className="panel panel-b chains">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: ".7rem" }}>
        <span className="panel-t" style={{ margin: 0 }}>Attack chains</span>
        <span className="est" title="Estimated by the LLM from this run's findings">LLM estimate</span>
        {resolved.length > 0 && <span className="muted" style={{ marginLeft: "auto", fontSize: ".78rem" }}>{resolved.length}</span>}
      </div>
      {resolved.length === 0 ? <EmptyState analysis={analysis} enabled={enabled} /> : resolved.map((c) => {
        const brk = c.steps[Math.min(c.break_index, c.steps.length - 1)];
        const on = selected === c.id;
        return (
          <div key={c.id} className={`chain ${on ? "on" : ""} ${c.live ? "" : "broken"}`} role="button" tabIndex={0}
            aria-expanded={on} onClick={() => onSelect(on ? null : c.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(on ? null : c.id))}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <SevPill sev={c.live ? c.severity : "info"} />
              <span className="muted" style={{ fontSize: ".74rem" }}>{c.confidence} confidence</span>
              {c.has_poc && !isAdmin && (
                <span className="est" title={`${c.poc_generated_by} confirmed this chain is exploitable, by hand`}>verified</span>
              )}
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
                {isAdmin && <ChainPoc submissionId={submissionId} chain={c} />}
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
