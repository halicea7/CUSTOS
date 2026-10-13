import React, { useState } from "react";
import { addRepo, validateToken } from "../api/repos.js";
import { useGroups } from "../api/queries.js";
import { errorMessage } from "../api/errors.js";
import { useTheme } from "../App.jsx";
import { Modal } from "./ui.jsx";
import { useToast } from "./Toast.jsx";

function generateSecret() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

const WEBHOOK_URL = `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ""}/api/webhook/github`;

function expiryText(ts) {
  if (!ts) return "no expiry date reported";
  const days = Math.ceil((new Date(ts) - Date.now()) / 86400000);
  const date = new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return days <= 0 ? `expired ${date}` : `expires in ${days} day${days !== 1 ? "s" : ""} (${date})`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };
  return <button className="btn sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>;
}

function Steps({ step }) {
  return (
    <div className="steps" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map(k => (
        <React.Fragment key={k}>
          <i className={k <= step ? "on" : ""}>{k < step ? "✓" : k}</i>
          {k < 3 && <b className={k < step ? "on" : ""} />}
        </React.Fragment>
      ))}
    </div>
  );
}

export default function AddRepoModal({ onClose, onAdded }) {
  const { theme } = useTheme();
  const toast = useToast();
  const { data: groups = [] } = useGroups();
  const [step, setStep] = useState(1);
  const [repoName, setRepoName] = useState("");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState(() => generateSecret());
  const [showToken, setShowToken] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleValidate = async () => {
    setValidating(true);
    setValidateResult(null);
    setError("");
    try {
      const result = await validateToken({ repo_full_name: repoName.trim(), github_token: token });
      setValidateResult(result);
      if (result.ok) setStep(2);
    } catch {
      setError("Validation request failed.");
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const repo = await addRepo({
        repo_full_name: repoName.trim(),
        github_token: token,
        webhook_secret: secret,
        group_ids: selectedGroups,
      });
      setStep(3);
      toast(`Added ${repo.repo_full_name}`);
      onAdded?.(repo);
    } catch (e) {
      setError(errorMessage(e, "Failed to add repository."));
    } finally {
      setSaving(false);
    }
  };

  const toggleGroup = (id) => {
    setSelectedGroups(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);
  };
  const canVerify = repoName.trim() && token && !validating;

  return (
    <Modal theme={theme} title="Add repository" onClose={onClose} width={540}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Steps step={step} />

        {step === 1 && (
          <>
            <div className="dim" style={{ fontSize: ".88rem" }}>
              Custos checks that the token can read the repository before saving it.
            </div>
            <div className="field">
              <label htmlFor="nr-name">Repository</label>
              <input id="nr-name" className="input mono" placeholder="owner/repo" value={repoName} autoFocus
                onChange={e => setRepoName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && canVerify && handleValidate()} />
              <div className="hint">Full name or URL, e.g. acme-uni/webapp</div>
            </div>
            <div className="field">
              <label htmlFor="nr-token">GitHub token</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input id="nr-token" className="input mono" type={showToken ? "text" : "password"} placeholder="ghp_…"
                  value={token} onChange={e => setToken(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && canVerify && handleValidate()} />
                <button className="btn sm" onClick={() => setShowToken(v => !v)}>{showToken ? "Hide" : "Show"}</button>
              </div>
              <div className="hint">
                Classic token: select <b>repo</b> (full). Fine-grained: Contents (read) and Pull requests (read),
                plus Checks (read/write) to post results on GitHub.
              </div>
            </div>
            <div className="field">
              <label htmlFor="nr-secret">Webhook secret</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input id="nr-secret" className="input mono" value={secret} onChange={e => setSecret(e.target.value)} />
                <button className="btn sm" onClick={() => setSecret(generateSecret())}>Regenerate</button>
              </div>
              <div className="hint">Only needed if you set up the optional webhook in the next step.</div>
            </div>
            {groups.length > 0 && (
              <div className="field">
                <label>Share with groups (optional)</label>
                <div className="chips">
                  {groups.map(g => (
                    <button key={g.id} className={`chip ${selectedGroups.includes(g.id) ? "on" : ""}`}
                      aria-pressed={selectedGroups.includes(g.id)} onClick={() => toggleGroup(g.id)}>{g.name}</button>
                  ))}
                </div>
              </div>
            )}
            {validateResult && !validateResult.ok && <div className="result bad">{validateResult.error}</div>}
          </>
        )}

        {step === 2 && (
          <>
            <div className="result ok">
              ✓ Token can read {validateResult?.repo_name || repoName} · {expiryText(validateResult?.token_expires_at)}
            </div>
            <div className="dim" style={{ fontSize: ".88rem", lineHeight: 1.6 }}>
              Custos checks the repository for new commits on a schedule (Settings), and you can press
              {" "}<b>Check for updates</b> on the Repositories page at any time. Neither needs GitHub to reach this server.
            </div>
            <details>
              <summary className="dim" style={{ cursor: "pointer", fontSize: ".86rem" }}>
                Optional: webhook for instant scans (only if GitHub can reach this server)
              </summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
                <div className="field">
                  <label>Payload URL</label>
                  <div className="copy-row"><span>{WEBHOOK_URL}</span><CopyButton text={WEBHOOK_URL} /></div>
                </div>
                <div className="field">
                  <label>Secret</label>
                  <div className="copy-row"><span>{secret}</span><CopyButton text={secret} /></div>
                </div>
                <div className="banner note" style={{ margin: 0 }}>
                  In GitHub → Settings → Webhooks → Add webhook: paste the payload URL, set the content type to
                  {" "}<span className="mono">application/json</span>, paste the secret, pick <b>Pushes</b> and
                  {" "}<b>Pull requests</b>, then click <b>Add webhook</b>.
                </div>
              </div>
            </details>
          </>
        )}

        {step === 3 && (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ fontSize: "2rem", color: "var(--ok)" }}>✓</div>
            <div style={{ fontWeight: 600, color: "var(--text)", margin: "6px 0" }}>{repoName.trim()} connected</div>
            <div className="muted" style={{ fontSize: ".86rem" }}>
              Press Check for updates to scan it now; otherwise Custos picks it up on its next scheduled check.
            </div>
          </div>
        )}

        {error && <div className="result bad">{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {step === 1 && (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={handleValidate} disabled={!canVerify}>
                {validating ? <><span className="spin" /> Verifying</> : "Verify access →"}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button className="btn" onClick={() => setStep(1)}>← Back</button>
              <button className="btn primary" onClick={handleSave} disabled={saving}>
                {saving ? <><span className="spin" /> Saving</> : "Save repository"}
              </button>
            </>
          )}
          {step === 3 && <button className="btn primary" onClick={onClose}>Done</button>}
        </div>
      </div>
    </Modal>
  );
}
