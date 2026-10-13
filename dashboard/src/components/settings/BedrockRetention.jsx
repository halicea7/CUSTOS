// Amazon Bedrock data retention: what applies to Custos's requests, and where to change it.
// Retention isn't a per-request option; it's a mode on a Bedrock project or on the
// whole account in one Region (effective = first non-inherit of project → account → model).
import React, { useCallback, useEffect, useState } from "react";
import { getBedrockRetention, setBedrockRetention } from "../../api/settings.js";
import { errorMessage } from "../../api/errors.js";
import { Modal, SectionCard } from "../ui.jsx";
import { useToast } from "../Toast.jsx";

const MODES = {
  inherit: ["Inherit", "Use the broader setting (account, then the model's default)."],
  none: ["No data retention", "Nothing is stored. Models that require retention are blocked."],
  default: ["Default (model's policy)", "AWS may keep data for abuse detection; the model provider never gets it."],
  aws_review: ["AWS review", "AWS may keep data up to 30 days and review it. Some models (e.g. Claude Fable 5) require this."],
  provider_data_share: ["Share with provider (legacy)", "Treated like AWS review; content isn't shared with providers today."],
};
const label = (m) => (m ? MODES[m]?.[0] || m : "—");
const SOURCE = { project: "set on the project", account: "set on the account", model: "the model's default" };

function Row({ k, children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "9.5rem minmax(0,1fr)", gap: 12, padding: "7px 0",
      borderTop: "1px solid var(--border)", fontSize: ".88rem", alignItems: "baseline" }}>
      <span className="muted">{k}</span><span style={{ color: "var(--text)", minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

function ModeSelect({ value, onChange, modes, disabled, id }) {
  return (
    <select id={id} className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      style={{ flex: "1 1 200px", minWidth: 0 }}>
      {modes.map((m) => <option key={m} value={m}>{label(m)}</option>)}
    </select>
  );
}

export default function BedrockRetention({ theme, cfg, unsaved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);           // "project" | "account" while saving
  const [projMode, setProjMode] = useState("none");
  const [acctMode, setAcctMode] = useState("none");
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const ready = cfg?.bedrock_region && cfg?.bedrock_api_key_set;

  const show = (d) => {
    setData(d);
    if (d.project?.mode) setProjMode(d.project.mode);
    if (d.account?.mode) setAcctMode(d.account.mode);
  };
  const load = useCallback(async () => {
    if (!ready) return;
    setLoading(true); setErr("");
    try { show(await getBedrockRetention()); } catch (e) { setErr(errorMessage(e, "Couldn't read retention settings")); }
    finally { setLoading(false); }
  }, [ready]);
  // Reload whenever the saved settings change (region, key, project, model).
  useEffect(() => { load(); }, [load, cfg]);

  const apply = async (scope, mode) => {
    setBusy(scope);
    try {
      show(await setBedrockRetention({ scope, mode, confirm_account: scope === "account" }));
      toast(`${scope === "project" ? "Project" : "Account-wide"} retention set to ${label(mode)}`);
      setConfirming(false); setUnderstood(false);
    } catch (e) {
      toast(errorMessage(e, "Couldn't change the retention mode"), { bad: true });
    } finally { setBusy(null); }
  };

  const runtime = cfg?.bedrock_endpoint === "runtime";
  const modes = data?.settable_modes || ["inherit", "none", "default", "aws_review"];
  const m = data?.model;
  const part = (p) => (p?.error ? <span style={{ color: "var(--crit)" }}>{p.error}</span> : null);

  return (
    <SectionCard theme={theme} title="Bedrock data retention"
      right={ready && <button className="btn sm" onClick={load} disabled={loading}>{loading ? <><span className="spin" /> Checking</> : "↻ Refresh"}</button>}>
      {unsaved && (
        <div className="banner note" style={{ marginBottom: 12 }}>
          This shows the <b>saved</b> Bedrock settings. Save your changes above to check or change retention for them.
        </div>
      )}
      {!ready ? (
        <div className="muted" style={{ fontSize: ".88rem" }}>Save a region and API key to see retention settings.</div>
      ) : err ? (
        <div className="result bad">{err}</div>
      ) : !data ? (
        <div className="muted">Checking…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            {!runtime && (
              <Row k="Effective mode">
                {m?.error ? part(m) : m ? <>{label(m.mode)} <span className="muted">· {SOURCE[m.source] || m.source} · for {m.id}</span></> : <span className="muted">save a model to see this</span>}
              </Row>
            )}
            {m?.allowed_modes?.length > 0 && <Row k="Model allows">{m.allowed_modes.map(label).join(" · ")}</Row>}
            {m?.status === "unavailable" && (
              <Row k="Model status"><span style={{ color: "var(--crit)" }}>Unavailable — {m.status_reason || "the current mode doesn't meet its requirement"}</span></Row>
            )}
            {!runtime && (
              <Row k="Project">
                {data.project ? (part(data.project) || <>{label(data.project.mode)} <span className="muted">· {data.project.name || data.project.id}</span></>)
                  : <span className="muted">none — requests use the account&rsquo;s default project</span>}
              </Row>
            )}
            <Row k={`Account · ${data.region}`}>{part(data.account) || label(data.account?.mode)}</Row>
            {runtime && (
              <Row k="Note"><span className="muted">bedrock-runtime has no projects and no per-model retention signal, so only the account mode applies here.</span></Row>
            )}
          </div>

          {!runtime && (
            <div className="field">
              <label htmlFor="ret-project">Custos&rsquo;s project</label>
              {data.project && !data.project.error ? (
                <div className="row-form">
                  <ModeSelect id="ret-project" value={projMode} onChange={setProjMode} modes={modes} disabled={!!busy || unsaved} />
                  <button className="btn primary" disabled={!!busy || unsaved || projMode === data.project.mode}
                    onClick={() => apply("project", projMode)}>
                    {busy === "project" ? <><span className="spin" /> Applying</> : "Apply to project"}
                  </button>
                </div>
              ) : (
                <div className="hint">Add a project ID in AI review above to give Custos its own mode without touching the rest of the account.</div>
              )}
              <div className="hint">{MODES[projMode]?.[1]}</div>
            </div>
          )}

          <div className="field">
            <label htmlFor="ret-account">Whole account in {data.region}</label>
            <div className="row-form">
              <ModeSelect id="ret-account" value={acctMode} onChange={setAcctMode} modes={modes} disabled={!!busy || unsaved} />
              <button className="btn danger" disabled={!!busy || unsaved || acctMode === data.account?.mode}
                onClick={() => setConfirming(true)}>Apply to whole account…</button>
            </div>
            <div className="hint">{MODES[acctMode]?.[1]} Affects every Bedrock user in this AWS account and Region.</div>
          </div>
        </div>
      )}

      {confirming && (
        <Modal theme={theme} title="Change retention for the whole account?" onClose={() => setConfirming(false)}
          subtitle={`${label(data?.account?.mode)} → ${label(acctMode)} · ${data?.region}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: ".9rem" }}>
            <div className="dim">
              This sets the Bedrock data-retention mode for <b>every application and person</b> using Bedrock in this
              AWS account in <b>{data?.region}</b>, not just Custos. Projects with their own mode keep it.
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} style={{ marginTop: 3 }} />
              <span>I&rsquo;ve checked with whoever owns this AWS account.</span>
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button className="btn danger" disabled={!understood || !!busy} onClick={() => apply("account", acctMode)}>
                {busy === "account" ? <><span className="spin" /> Applying</> : `Set account to ${label(acctMode)}`}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </SectionCard>
  );
}
