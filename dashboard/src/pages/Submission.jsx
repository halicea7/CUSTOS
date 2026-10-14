import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useAuth, useTheme } from "../App.jsx";
import { SEV_ORDER } from "../theme.js";
import { Modal } from "../components/ui.jsx";
import { Status, ago, sevVar } from "../components/queue/Board.jsx";
import {
  DecisionButtons, DispTag, FindingBody, SEV_LABEL, SevPill, findingLoc, sourceLabel,
} from "../components/submission/FindingDetail.jsx";
import { LLM_ACTIVE, LlmProgress, LlmRuns } from "../components/submission/LlmPanel.jsx";
import ReportModal from "../components/submission/ReportModal.jsx";
import { downloadBlob, generateRemediations, remediationTasks } from "../components/submission/report.js";
import {
  useChains, useComparison, useDispose, useInvalidateSubmission, useLlmStatus, useRerunLlm, useReturnSignoff,
  useSignOff, useSignoffs, useSubmission, useSubmissionFindings,
} from "../api/queries.js";
import Chains, { chainGatePending, resolveChains } from "../components/submission/Chains.jsx";
import { errorMessage } from "../api/errors.js";
import { useToast } from "../components/Toast.jsx";

const IN_FLIGHT = new Set(["pending", "analyzing"]);
const RING = 251.3; // circumference of the r=40 progress ring
const HOTKEYS = { f: "false_positive", c: "confirmed", e: "escalated" };
const DONE_WORD = { false_positive: "false positive", confirmed: "confirmed", escalated: "escalated" };
const isCritHigh = (f) => f.severity === "critical" || f.severity === "high";
const plural = (k, w) => `${k} ${w}${k !== 1 ? "s" : ""}`;
const sevRank = (s) => { const i = SEV_ORDER.indexOf(s); return i < 0 ? SEV_ORDER.length : i; };
const GROUP_KEY = { sev: (f) => f.severity, file: (f) => f.file_path || "(no file)", src: (f) => f.source };

// ── Header pieces ────────────────────────────────────────────────────────────

const STAGE = {
  analyst_sign_off: ["Signed off for approval", "var(--low)"],
  sign_off: ["Approved and signed off", "var(--ok)"],
  sign_off_returned: ["Sent back for review", "var(--high)"],
};

// mode: "signoff" (analyst stage 1, or an admin's one-step sign-off), "approve" (admin, stage 2),
// "return" (admin sends an analyst's sign-off back).
function SignOffModal({ sub, findings, chainPending, mode, onClose }) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const toast = useToast();
  const signOff = useSignOff(sub.id);
  const giveBack = useReturnSignoff(sub.id);
  const [note, setNote] = useState("");
  const admin = user?.role === "admin";
  const sending = mode === "return";
  const open = findings.filter((f) => isCritHigh(f) && !f.disposition).length;
  const chainOpen = [...chainPending].filter((id) => !findings.find((f) => f.id === id && isCritHigh(f))).length;
  const adminOnly = sub.is_self_update && !admin;
  const blocked = !sending && (open > 0 || chainOpen > 0 || adminOnly);
  const busy = signOff.isPending || giveBack.isPending;
  const error = signOff.error || giveBack.error;

  const submit = () => (sending
    ? giveBack.mutate(note.trim(), { onSuccess: () => { toast("Sent back for review"); onClose(); } })
    : signOff.mutate(note, {
      onSuccess: (s) => {
        toast(s.status === "awaiting_approval" ? "Signed off: waiting for an admin to approve" : "Signed off");
        onClose();
      },
    }));
  const title = sending ? "Send back for more review?" : mode === "approve" ? "Approve this sign-off?" : "Sign off this run?";
  const action = sending ? "Send back" : mode === "approve" ? "Approve" : admin ? "Sign off" : "Sign off for approval";

  return (
    <Modal theme={theme} title={title} onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {!sending && open > 0 && (
          <div className="banner bad" style={{ margin: 0 }}>
            <b>{plural(open, "critical/high finding")} still untriaged.</b> Give each one a decision before signing off.
          </div>
        )}
        {!sending && chainOpen > 0 && (
          <div className="banner bad" style={{ margin: 0 }}>
            <b>⛓ {plural(chainOpen, "finding")} in a critical/high attack chain still untriaged.</b> They&rsquo;re lower
            severity on their own, but together they make a serious attack. Decide each one first.
          </div>
        )}
        {!blocked && !sending && (
          <div className="dim">
            {mode === "approve" ? "Approving makes the sign-off final: it's recorded in the audit log and the GitHub check passes."
              : admin ? "As an admin, this signs the run off in one step and records it in the audit log."
                : "This is the first stage: an admin reviews your sign-off and approves it or sends it back."}
          </div>
        )}
        {sending && <div className="dim">The run goes back to <b>Needs review</b>. Your reason is shown on the run page.</div>}
        {sub.is_self_update && !sending && (
          <div className="banner note" style={{ margin: 0 }}>
            <b>This is Custos&rsquo;s own repository.</b> Signing off approves deploying this commit to Custos itself
            on its next <span className="mono">./custos update</span>, so only admins can do it. Findings marked
            confirmed or escalated block the update.
          </div>
        )}
        <div className="field">
          <label htmlFor="signoff-note">{sending ? "Reason (required)" : "Comment (optional)"}</label>
          <textarea id="signoff-note" className="input textarea" rows={3} value={note} autoFocus
            placeholder={sending ? "What needs another look?" : "Anything the next reviewer should know"}
            onChange={(e) => setNote(e.target.value)} disabled={blocked} />
        </div>
        {error && <div className="result bad">{errorMessage(error, "That didn't work")}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${sending ? "danger" : "primary"}`} onClick={submit}
            disabled={blocked || busy || (sending && !note.trim())}
            title={adminOnly ? "Only admins can sign off Custos's own repository" : undefined}>
            {busy ? <><span className="spin" /> Saving</> : action}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Every sign-off stage with its comment, so analysts and admins can read each other's notes. */
function SignoffHistory({ id }) {
  const { data: rows = [] } = useSignoffs(id);
  if (!rows.length) return null;
  return (
    <section className="panel panel-b">
      <div className="panel-t">Sign-off</div>
      {rows.map((r, i) => {
        const [label, color] = STAGE[r.action] || [r.action, "var(--text3)"];
        return (
          <div key={i} className="so-row">
            <span className="dot" style={{ background: color }} />
            <div style={{ minWidth: 0 }}>
              <div><b style={{ color: "var(--text)" }}>{r.by}</b> · {label}
                <span className="muted" title={new Date(r.at).toLocaleString()}> · {ago(r.at)}</span></div>
              {r.note && <div className="so-note">{r.note}</div>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ── What changed since the last scan ────────────────────────────────────────

function Changes({ cmp, isPending, findings, isNew, change, onChange }) {
  const prev = cmp?.previous;
  const fresh = prev ? findings.filter(isNew).length : 0;
  const same = prev ? findings.length - fresh : findings.length;
  const fixed = cmp?.fixed || [];
  const dash = isPending ? "…" : null;
  return (
    <section className="changes" data-tour="run-changes">
      <button className={`tile ch-new ${change === "new" ? "on" : ""}`} disabled={!prev}
        onClick={() => onChange(change === "new" ? null : "new")}>
        <div className="k"><span className="dot" style={{ background: "var(--accent)" }} />New since last scan</div>
        <div className="v">{dash ?? fresh}</div>
        <div className="h">{prev ? (change === "new" ? "showing only these" : "click to show only these") : "first scan of this repo"}</div>
      </button>
      <div className="tile ch-fixed">
        <div className="k"><span className="dot" style={{ background: "var(--ok)" }} />Fixed</div>
        <div className="v">{dash ?? fixed.length}</div>
        <div className="h">gone since the last scan</div>
      </div>
      <button className={`tile ${change === "same" ? "on" : ""}`} disabled={!prev}
        onClick={() => onChange(change === "same" ? null : "same")}>
        <div className="k"><span className="dot" style={{ background: "var(--text3)" }} />Unchanged</div>
        <div className="v">{dash ?? same}</div>
        <div className="h">also in the last scan</div>
      </button>
      <div className="tile wide">
        {isPending ? <div className="dim">Comparing with the previous scan…</div> : prev ? (
          <>
            <div className="dim" style={{ fontSize: ".86rem" }}>
              Compared with <b style={{ color: "var(--text)" }} className="mono">{prev.commit_sha.slice(0, 7)}</b>
              {" "}({prev.pr_number ? `PR #${prev.pr_number}` : prev.branch || "no branch"}, {ago(prev.created_at)},
              {" "}{prev.status === "signed_off" ? "signed off" : "not signed off"})
            </div>
            <div className="fixed-list">
              {fixed.length ? fixed.map((f) => (
                <div key={f.id} title={f.title}>
                  <span className="dot" style={{ background: "var(--ok)" }} /><s>{f.title}</s>
                  <span className="mono">{findingLoc(f)}</span>
                </div>
              )) : <div>Nothing fixed since then.</div>}
            </div>
          </>
        ) : (
          <div className="dim">This is the first scan of this repository, so there&rsquo;s nothing to compare with yet.</div>
        )}
      </div>
    </section>
  );
}

// ── Drawer and bulk bar ─────────────────────────────────────────────────────

function Drawer({ finding, sub, isNew, onStep, onClose, onDecide, busy }) {
  const [note, setNote] = useState("");
  const f = finding;
  return (
    <>
      <div className="dh">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <SevPill sev={f.severity} /><span className="src">{sourceLabel(f.source)}</span>
            {isNew && <span className="newtag">NEW</span>}<DispTag disposition={f.disposition} />
          </div>
          <h2 style={{ overflowWrap: "anywhere" }}>{f.title}</h2>
          <div className="fsub" style={{ marginTop: 6 }}>
            {f.file_path && <span className="path">{findingLoc(f)}</span>}
            {f.cwe && <span>{f.cwe}</span>}
            <span className="mono">{sub.commit_sha.slice(0, 7)}</span>
            {f.disposed_by && <span>decided by {f.disposed_by} {ago(f.disposed_at)}</span>}
          </div>
        </div>
        <button className="btn sm" onClick={() => onStep(-1)} title="Previous (K)">↑</button>
        <button className="btn sm" onClick={() => onStep(1)} title="Next (J)">↓</button>
        <button className="btn sm" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <div className="db">
        <FindingBody finding={f} />
        <div className="field">
          <h3><label htmlFor="finding-note">Note</label></h3>
          <textarea id="finding-note" className="input textarea" rows={2} value={note}
            onChange={(e) => setNote(e.target.value)} placeholder="Why? (saved with your decision)" />
        </div>
      </div>
      <div className="df">
        <DecisionButtons current={f.disposition} disabled={busy} onDecide={(d) => onDecide(d, note)} />
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: ".8rem" }}>Moves to the next finding</span>
      </div>
    </>
  );
}

function BulkBar({ count, onDecide, onClear, busy }) {
  const [note, setNote] = useState("");
  return (
    <div className={`bulk ${count ? "show" : ""}`} aria-hidden={!count}>
      <span><b>{count}</b> selected</span>
      <input className="input" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional, applies to all)" style={{ width: 230, padding: ".38rem .7rem" }} />
      <DecisionButtons disabled={busy} onDecide={(d) => onDecide(d, note, () => setNote(""))} />
      <button className="btn" onClick={onClear}>Clear</button>
    </div>
  );
}

// ── Side column ─────────────────────────────────────────────────────────────

function Progress({ findings }) {
  const done = findings.filter((f) => f.disposition).length;
  const ch = findings.filter(isCritHigh);
  return (
    <section className="panel panel-b">
      <div className="panel-t">Triage progress</div>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <svg className="ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle className="bg" cx="50" cy="50" r="40" />
          <circle className="fg" cx="50" cy="50" r="40" strokeDasharray={RING}
            strokeDashoffset={RING * (1 - (findings.length ? done / findings.length : 1))} />
        </svg>
        <div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600, color: "var(--text)" }}>{done} / {findings.length}</div>
          <div className="muted" style={{ fontSize: ".82rem" }}>findings triaged</div>
          <div className="muted" style={{ fontSize: ".82rem", marginTop: 4 }}>
            critical + high: {ch.filter((f) => f.disposition).length} of {ch.length}
          </div>
        </div>
      </div>
    </section>
  );
}

function SeverityBars({ findings }) {
  const counts = Object.fromEntries(SEV_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const mx = Math.max(...Object.values(counts), 1);
  return (
    <section className="panel panel-b">
      <div className="panel-t">By severity</div>
      <div className="bars">
        {SEV_ORDER.map((s) => (
          <div key={s} className="bar-row">
            <span>{SEV_LABEL[s]}</span>
            <div className="track"><span style={{ width: `${(counts[s] / mx) * 100}%`, background: `var(--${sevVar(s)})` }} /></div>
            <span className="mono" style={{ textAlign: "right" }}>{counts[s]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Keys() {
  return (
    <section className="panel panel-b">
      <div className="panel-t">Keyboard</div>
      <div className="keys">
        <span><span className="kbd">J</span> <span className="kbd">K</span></span><span>next / previous finding</span>
        <span><span className="kbd">↵</span></span><span>open the finding</span>
        <span><span className="kbd">X</span></span><span>select for bulk triage</span>
        <span><span className="kbd">F</span> <span className="kbd">C</span> <span className="kbd">E</span></span>
        <span>false positive / confirm / escalate</span>
        <span><span className="kbd">Esc</span></span><span>close / clear selection</span>
      </div>
    </section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Submission() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const toast = useToast();

  const subQuery = useSubmission(id);
  const sub = subQuery.data;
  const inFlight = !sub || IN_FLIGHT.has(sub.status);
  const findingsQuery = useSubmissionFindings(id, inFlight ? "analyzing" : sub.status);
  const findings = useMemo(() => findingsQuery.data || [], [findingsQuery.data]);
  const cmpQuery = useComparison(id, inFlight ? "analyzing" : sub.status);
  const [chainOn, setChainOn] = useState(null);           // selected attack chain id
  const { data: chainsData } = useChains(id, inFlight ? "analyzing" : sub.status);
  const { data: signoffs = [] } = useSignoffs(id);
  const chainList = useMemo(() => resolveChains(chainsData?.chains, findings), [chainsData, findings]);
  const activeChain = chainList.find((c) => c.id === chainOn) || null;
  // finding id → strongest live chain it's part of, for the row tags.
  const chainTags = useMemo(() => {
    const m = new Map();
    chainList.filter((c) => c.live).forEach((c) => c.steps.forEach((st) => {
      const cur = m.get(st.f.id);
      if (!cur) m.set(st.f.id, { sev: c.severity, ref: st.ref, n: 1, titles: [c.title] });
      else {
        cur.n += 1; cur.titles.push(c.title);
        if (sevRank(c.severity) < sevRank(cur.sev)) cur.sev = c.severity;
      }
    }));
    return m;
  }, [chainList]);
  const selectChain = (cid) => {
    setChainOn(cid);
    if (cid) setTimeout(() => document.querySelector(".frow.chain-hl")?.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
  };
  const lastStage = signoffs.at(-1);
  const refresh = useInvalidateSubmission(id);
  const dispose = useDispose(id);
  const { data: llm, refetch: refetchLlm } = useLlmStatus(id);
  const rerun = useRerunLlm(id);

  const [src, setSrc] = useState(null);
  const [untriaged, setUntriaged] = useState(false);
  const [pathQ, setPathQ] = useState("");
  const [groupBy, setGroupBy] = useState("sev");
  const [change, setChange] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [focusId, setFocusId] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showSignOff, setShowSignOff] = useState(null);   // null | "signoff" | "approve" | "return"
  const [animKey, setAnimKey] = useState(0);

  // A different run: start fresh.
  useEffect(() => {
    setSrc(null); setUntriaged(false); setPathQ(""); setChange(null);
    setSelected(new Set()); setFocusId(null); setDrawer(false);
  }, [id]);

  // When a re-run we watched finishes, reload the findings and say so.
  const lastLlm = useRef(null);
  useEffect(() => {
    const now = llm?.status;
    if (LLM_ACTIVE.has(lastLlm.current) && (now === "complete" || now === "failed")) {
      refresh();
      toast(now === "complete" ? "LLM re-run finished; findings updated" : "LLM re-run failed; see LLM runs",
        now === "failed" ? { bad: true } : undefined);
    }
    lastLlm.current = now ?? null;
  }, [llm?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const newIds = useMemo(() => new Set(cmpQuery.data?.new_finding_ids || []), [cmpQuery.data]);
  const hasPrev = !!cmpQuery.data?.previous;
  const isNew = (f) => hasPrev && newIds.has(f.id);

  // Filter, sort and group; `flat` is the on-screen order for J/K.
  const q = pathQ.trim().toLowerCase();
  const keyOf = GROUP_KEY[groupBy];
  const visible = findings
    .filter((f) => (!src || f.source === src) && (!untriaged || !f.disposition)
      && (!q || (f.file_path || "").toLowerCase().includes(q))
      && (!change || (change === "new" ? isNew(f) : !isNew(f))))
    .sort((a, b) => (groupBy === "sev" ? 0 : String(keyOf(a)).localeCompare(String(keyOf(b))))
      || sevRank(a.severity) - sevRank(b.severity) || (a.file_path || "").localeCompare(b.file_path || ""));
  const groups = [];
  visible.forEach((f) => {
    const k = keyOf(f);
    const g = groups.at(-1);
    if (g && g.key === k) g.items.push(f); else groups.push({ key: k, items: [f] });
  });
  if (groupBy === "sev") groups.sort((a, b) => sevRank(a.key) - sevRank(b.key));
  const flat = groups.flatMap((g) => g.items);
  const focusIdx = flat.findIndex((f) => f.id === focusId);
  const open = drawer ? findings.find((f) => f.id === focusId) : null;
  // Keep showing the last finding while the drawer slides closed.
  const shown = useRef(null);
  if (open) shown.current = open;

  const sources = [...new Set(findings.map((f) => f.source))].sort()
    .map((s) => [s, findings.filter((f) => f.source === s).length]);

  const refilter = (fn) => (v) => { fn(v); setAnimKey((k) => k + 1); };

  const step = (d) => {
    if (!flat.length) return;
    const i = focusIdx < 0 ? (d > 0 ? 0 : flat.length - 1) : Math.max(0, Math.min(flat.length - 1, focusIdx + d));
    setFocusId(flat[i].id);
  };
  const openFinding = (fid) => { setFocusId(fid); setDrawer(true); };
  const toggleSel = (fid) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(fid)) next.delete(fid); else next.add(fid);
    return next;
  });

  const decide = (ids, disposition, note, done) => dispose.mutate({ ids, disposition, note }, {
    onSuccess: () => { toast(`Marked ${plural(ids.length, "finding")} ${DONE_WORD[disposition]}`); done?.(); },
    onError: (e) => toast(errorMessage(e, "Couldn't save the decision"), { bad: true }),
  });
  // Decide the focused finding and move on to the next one.
  const decideFocused = (disposition, note) => {
    const target = open || flat[focusIdx];
    if (!target) return;
    decide([target.id], disposition, note);
    const i = flat.findIndex((f) => f.id === target.id);
    if (flat[i + 1]) setFocusId(flat[i + 1].id);
  };
  const decideSelected = (disposition, note, done) => {
    decide([...selected], disposition, note, () => { setSelected(new Set()); done?.(); });
  };

  // Keep the focused row in view.
  useEffect(() => {
    if (focusId) document.querySelector(`.frow[data-fid="${focusId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusId]);

  // J/K/↵/X/F/C/E/Esc. Ignored while typing or when a dialog is open.
  useEffect(() => {
    if (inFlight) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
      if (showReport || showSignOff || document.querySelector(".palette.show")) return;
      const k = e.key.toLowerCase();
      const cur = flat[focusIdx];
      if (k === "j") step(1);
      else if (k === "k") step(-1);
      else if (k === "enter" && cur) openFinding(cur.id);
      else if (k === "x" && cur) toggleSel(cur.id);
      else if (HOTKEYS[k] && !dispose.isPending) {
        if (selected.size && !drawer) decideSelected(HOTKEYS[k]);
        else if (open || cur) decideFocused(HOTKEYS[k], document.getElementById("finding-note")?.value);
        else return;
      } else if (k === "escape") {
        if (drawer) setDrawer(false); else if (chainOn) setChainOn(null); else setSelected(new Set());
      } else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const queryError = subQuery.error || findingsQuery.error;
  if (queryError) {
    return (
      <div className="page">
        <button className="back" onClick={() => navigate("/")}>← Back to queue</button>
        <div className="banner bad">{errorMessage(queryError, "Failed to load this run")}</div>
      </div>
    );
  }
  if (!sub || (!inFlight && findingsQuery.isPending)) return <div className="page"><div className="empty">Loading run…</div></div>;

  const llmBusy = LLM_ACTIVE.has(llm?.status) || rerun.isPending;
  const canRemediate = !inFlight && remediationTasks(findings).length > 0;
  const startRerun = () => rerun.mutate(undefined, {
    onSuccess: () => { refetchLlm(); toast("LLM re-run queued"); },
    onError: (e) => toast(errorMessage(e, "Couldn't start the re-run"), { bad: true }),
  });

  return (
    <div className="page glow">
      <button className="back" onClick={() => navigate("/")}>← Back to queue</button>
      <div className="top" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ overflowWrap: "anywhere" }}>{sub.repo_full_name}</h1>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <span className="tag" title={sub.commit_sha}>{sub.commit_sha.slice(0, 12)}</span>
            {(sub.pr_number || sub.branch) && (
              <span className="tag">{sub.pr_number ? `PR #${sub.pr_number}` : ""}{sub.pr_number && sub.branch ? " · " : ""}{sub.branch}</span>
            )}
            {sub.event_type && <span className="tag">{sub.event_type}</span>}
          </div>
        </div>
        <div className="meta">
          {sub.submitter && <div><div className="lbl">Submitter</div><div className="v">{sub.submitter}</div></div>}
          {sub.github_actor && sub.github_actor !== sub.submitter && (
            <div><div className="lbl">Actor</div><div className="v">{sub.github_actor}</div></div>
          )}
          <div><div className="lbl">Submitted</div><div className="v mono" title={new Date(sub.created_at).toLocaleString()}>{ago(sub.created_at)}</div></div>
          <Status status={sub.status} />
          {isAdmin && (
            <button className="btn" disabled={inFlight || llmBusy} onClick={startRerun}
              title="Re-clones the same commit; only LLM findings are replaced">
              {llmBusy ? <><span className="spin" /> Re-running</> : "↻ Re-run LLM"}
            </button>
          )}
          <button className="btn" disabled={inFlight} onClick={() => setShowReport(true)} data-tour="run-report">↓ Report</button>
          <button className="btn" disabled={!canRemediate} data-tour="run-remediations"
            title={canRemediate ? "Task file for an AI coding agent: fixes for the findings, most severe first" : "Nothing to remediate"}
            onClick={() => downloadBlob(generateRemediations(sub, findings, chainList), "REMEDIATIONS.md", "text/markdown")}>
            ↓ REMEDIATIONS.md
          </button>
          {sub.status === "awaiting_approval" && isAdmin ? (
            <>
              <button className="btn danger" onClick={() => setShowSignOff("return")}>Send back</button>
              <button className="btn primary" onClick={() => setShowSignOff("approve")} data-tour="run-signoff">Approve sign-off</button>
            </>
          ) : (
            <button className="btn primary" disabled={sub.status !== "needs_review"} data-tour="run-signoff"
              onClick={() => setShowSignOff("signoff")}
              title={sub.status === "awaiting_approval" ? "Signed off by an analyst; an admin needs to approve it" : undefined}>
              {sub.status === "signed_off" ? "Signed off ✓" : sub.status === "awaiting_approval" ? "Awaiting approval"
                : isAdmin ? "Sign off" : "Sign off for approval"}
            </button>
          )}
        </div>
      </div>

      {sub.error_message && (
        <div className={`banner ${sub.status === "error" ? "bad" : "note"}`}>
          <b>{sub.status === "error" ? "Analysis failed: " : "Note: "}</b>{sub.error_message}
        </div>
      )}
      {sub.status === "needs_review" && lastStage?.action === "sign_off_returned" && (
        <div className="banner note">
          <b>Sent back by {lastStage.by}</b> {ago(lastStage.at)}{lastStage.note ? <>: {lastStage.note}</> : "."} Address it, then sign off again.
        </div>
      )}
      {sub.status === "awaiting_approval" && (
        <div className="banner note">
          <b>Signed off by {lastStage?.by || "an analyst"}</b>, waiting for an admin to approve.
          {lastStage?.note && <> Comment: &ldquo;{lastStage.note}&rdquo;</>}
        </div>
      )}
      <LlmProgress status={llm} />

      {inFlight ? (
        <div className="panel">
          <div className="empty">
            <div style={{ fontWeight: 600, color: "var(--accent)", marginBottom: 6 }}>
              {sub.status === "pending" ? "Waiting for a worker" : "Analysis in progress"}
            </div>
            Static tools, SentinelOne and the LLM are scanning this commit. Findings appear here when it finishes.
          </div>
        </div>
      ) : (
        <>
          <Changes cmp={cmpQuery.data} isPending={cmpQuery.isPending} findings={findings} isNew={isNew}
            change={change} onChange={refilter(setChange)} />
          <div className="cols">
            <section className="panel" data-tour="run-findings">
              <div className="filters">
                <span className="lbl">Tool</span>
                <div className="chips">
                  <button className={`chip ${!src ? "on" : ""}`} onClick={() => refilter(setSrc)(null)}>All</button>
                  {sources.map(([s, c]) => (
                    <button key={s} className={`chip ${src === s ? "on" : ""}`} onClick={() => refilter(setSrc)(s)}>
                      {sourceLabel(s)}<span className="n">{c}</span>
                    </button>
                  ))}
                </div>
                <button className={`toggle ${untriaged ? "on" : ""}`} aria-pressed={untriaged}
                  onClick={() => refilter(setUntriaged)(!untriaged)}>
                  <span className="switch" />Untriaged only
                </button>
                <input className="input mono" value={pathQ} onChange={(e) => setPathQ(e.target.value)}
                  placeholder="filter by path…" aria-label="Filter by path"
                  style={{ width: "clamp(170px,13vw,300px)", padding: ".38rem .7rem" }} />
                <div className="seg" style={{ marginLeft: "auto" }}>
                  {[["sev", "Severity"], ["file", "File"], ["src", "Tool"]].map(([k, l]) => (
                    <button key={k} className={groupBy === k ? "on" : ""} onClick={() => refilter(setGroupBy)(k)}>{l}</button>
                  ))}
                </div>
              </div>

              <div key={animKey} className={`flist anim ${activeChain ? "chain-mode" : ""}`}>
                {!flat.length ? (
                  <div className="empty">{findings.length ? "Nothing matches these filters." : "No findings: this commit is clean."}</div>
                ) : groups.map((g) => (
                  <div key={g.key}>
                    <div className="group-h">
                      {groupBy === "sev" ? <SevPill sev={g.key} />
                        : <span className="mono" style={{ fontSize: ".85rem", color: "var(--text)", overflowWrap: "anywhere" }}>
                          {groupBy === "src" ? sourceLabel(g.key) : g.key}</span>}
                      <span className="mono muted" style={{ fontSize: ".78rem" }}>{g.items.length}</span>
                      <span className="line" />
                      <button className="link" onClick={() => setSelected((prev) => new Set([...prev, ...g.items.map((f) => f.id)]))}>
                        select all
                      </button>
                    </div>
                    {g.items.map((f) => {
                      const i = flat.indexOf(f);
                      return (
                        <div key={f.id} data-fid={f.id}
                          className={`frow ${selected.has(f.id) ? "sel" : ""} ${focusId === f.id ? "focus" : ""} ${activeChain?.steps.some((st) => st.f?.id === f.id) ? "chain-hl" : ""}`}
                          style={{ "--sev": `var(--${sevVar(f.severity)})`, animationDelay: `${Math.min(i, 14) * 18}ms` }}
                          onClick={() => openFinding(f.id)}>
                          <button className="cb" aria-label="Select for bulk triage" aria-pressed={selected.has(f.id)}
                            onClick={(e) => { e.stopPropagation(); toggleSel(f.id); }} />
                          {groupBy === "sev" ? <span className="src">{sourceLabel(f.source)}</span> : <SevPill sev={f.severity} />}
                          <div style={{ minWidth: 0 }}>
                            <div className="ttl" title={f.title}>{f.title}</div>
                            <div className="fsub">
                              {isNew(f) && <span className="newtag">NEW</span>}
                              {chainTags.get(f.id) && (() => {
                                const t = chainTags.get(f.id);
                                return (
                                  <span className="chaintag" title={t.titles.join(" · ")}
                                    style={{ color: `var(--${sevVar(t.sev)})`, background: `var(--${sevVar(t.sev)}-bg)` }}>
                                    ⛓ {t.ref} · chain: {t.sev}{t.n > 1 ? ` ×${t.n}` : ""}
                                  </span>
                                );
                              })()}
                              {f.file_path && <span className="path">{findingLoc(f)}</span>}
                              {f.cwe && <span>{f.cwe}</span>}
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <DispTag disposition={f.disposition} /><span className="chev">›</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </section>

            <div className="side">
              <SignoffHistory id={id} />
              <Progress findings={findings} />
              <SeverityBars findings={findings} />
              <Chains resolved={chainList} selected={chainOn} onSelect={selectChain}
                analysis={chainsData?.analysis} enabled={chainsData?.enabled !== false} />
              <LlmRuns submissionId={id} />
              <Keys />
            </div>
          </div>
        </>
      )}

      <div className={`scrim ${open ? "show" : ""}`} onClick={() => setDrawer(false)} />
      <aside className={`drawer ${open ? "show" : ""}`} aria-hidden={!open}>
        {shown.current && (
          <Drawer key={shown.current.id} finding={shown.current} sub={sub} isNew={isNew(shown.current)} busy={dispose.isPending}
            onStep={step} onClose={() => setDrawer(false)} onDecide={decideFocused} />
        )}
      </aside>
      <BulkBar count={selected.size} busy={dispose.isPending} onDecide={decideSelected}
        onClear={() => setSelected(new Set())} />

      {showReport && <ReportModal sub={sub} findings={findings} chains={chainList} cmp={cmpQuery.data}
        signoffs={signoffs} onClose={() => setShowReport(false)} />}
      {showSignOff && <SignOffModal sub={sub} findings={findings} mode={showSignOff}
        chainPending={chainsData?.gate ? chainGatePending(chainList) : new Set()} onClose={() => setShowSignOff(null)} />}
    </div>
  );
}
