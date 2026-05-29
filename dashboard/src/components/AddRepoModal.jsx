import React, { useEffect, useState } from "react";
import { addRepo, validateToken } from "../api/repos.js";
import { listGroups } from "../api/groups.js";

function generateSecret() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

const WEBHOOK_URL = `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ""}/api/webhook/github`;

const S = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000, backdropFilter: "blur(4px)",
  },
  modal: {
    background: "var(--bg-2)", border: "1px solid var(--border-2)",
    borderRadius: "var(--radius)", width: "520px", maxWidth: "calc(100vw - 32px)",
    maxHeight: "90vh", overflow: "auto",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "16px 20px", borderBottom: "1px solid var(--border)",
  },
  body: { padding: "20px" },
  footer: {
    display: "flex", justifyContent: "flex-end", gap: "8px",
    padding: "16px 20px", borderTop: "1px solid var(--border)",
  },
  label: { display: "block", fontSize: "11px", color: "var(--text-2)", letterSpacing: "0.06em", marginBottom: "6px" },
  input: {
    width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", padding: "8px 10px", color: "var(--text)",
    fontSize: "13px", fontFamily: "var(--mono)", outline: "none", boxSizing: "border-box",
  },
  row: { marginBottom: "14px" },
  btn: (variant = "default") => ({
    padding: "7px 16px", borderRadius: "var(--radius)", cursor: "pointer",
    fontSize: "11px", letterSpacing: "0.06em", fontFamily: "var(--mono)",
    border: variant === "primary" ? "none" : "1px solid var(--border)",
    background: variant === "primary" ? "var(--accent)" : "transparent",
    color: variant === "primary" ? "#000" : "var(--text-2)",
    fontWeight: variant === "primary" ? 700 : 400,
    opacity: 1,
  }),
  hint: { fontSize: "10px", color: "var(--text-3)", marginTop: "4px" },
  code: {
    display: "flex", alignItems: "center", gap: "8px",
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", padding: "8px 10px",
    fontFamily: "var(--mono)", fontSize: "12px", color: "var(--accent)",
    wordBreak: "break-all",
  },
  stepper: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "20px" },
};

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };
  return (
    <button onClick={copy} style={{ ...S.btn(), padding: "3px 8px", flexShrink: 0, fontSize: "10px" }}>
      {copied ? "COPIED" : "COPY"}
    </button>
  );
}

function Stepper({ step }) {
  return (
    <div style={S.stepper}>
      {[1, 2, 3].map(n => (
        <React.Fragment key={n}>
          <div style={{
            width: "22px", height: "22px", borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "11px", fontFamily: "var(--mono)", fontWeight: 700,
            background: n <= step ? "var(--accent)" : "var(--bg)",
            color: n <= step ? "#000" : "var(--text-3)",
            border: n <= step ? "none" : "1px solid var(--border)",
            flexShrink: 0,
          }}>{n < step ? "✓" : n}</div>
          {n < 3 && <div style={{ flex: 1, height: "1px", background: n < step ? "var(--accent)" : "var(--border)" }} />}
        </React.Fragment>
      ))}
    </div>
  );
}

export default function AddRepoModal({ onClose, onAdded }) {
  const [step, setStep] = useState(1);
  const [repoName, setRepoName] = useState("");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState(() => generateSecret());
  const [showToken, setShowToken] = useState(false);
  const [groups, setGroups] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listGroups().then(setGroups).catch(() => {});
  }, []);

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
      onAdded?.(repo);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to add repository.");
    } finally {
      setSaving(false);
    }
  };

  const toggleGroup = (id) => {
    setSelectedGroups(prev =>
      prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
    );
  };

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={S.header}>
          <span style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.06em", color: "var(--text)" }}>
            ADD REPOSITORY
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: "18px", lineHeight: 1 }}>×</button>
        </div>

        <div style={S.body}>
          <Stepper step={step} />

          {step === 1 && (
            <>
              <p style={{ fontSize: "12px", color: "var(--text-2)", marginBottom: "16px", marginTop: 0 }}>
                Enter the repository details. Custos will verify your token has access before saving.
              </p>

              <div style={S.row}>
                <label style={S.label}>REPOSITORY</label>
                <input
                  style={S.input}
                  placeholder="owner/repo"
                  value={repoName}
                  onChange={e => setRepoName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && repoName && token && handleValidate()}
                  autoFocus
                />
                <p style={S.hint}>Full name or URL — e.g. acme-uni/webapp</p>
              </div>

              <div style={S.row}>
                <label style={S.label}>GITHUB TOKEN</label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    style={{ ...S.input, flex: 1 }}
                    type={showToken ? "text" : "password"}
                    placeholder="ghp_..."
                    value={token}
                    onChange={e => setToken(e.target.value)}
                  />
                  <button onClick={() => setShowToken(v => !v)} style={{ ...S.btn(), flexShrink: 0, fontSize: "10px" }}>
                    {showToken ? "HIDE" : "SHOW"}
                  </button>
                </div>
                <p style={S.hint}>Classic token: select <strong style={{color:"var(--text-2)"}}>repo</strong> (full). Fine-grained: Contents (read) + Commit statuses (read/write)</p>
              </div>

              <div style={S.row}>
                <label style={S.label}>WEBHOOK SECRET</label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    style={{ ...S.input, flex: 1 }}
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                  />
                  <button onClick={() => setSecret(generateSecret())} style={{ ...S.btn(), flexShrink: 0, fontSize: "10px" }}>
                    REGEN
                  </button>
                </div>
                <p style={S.hint}>You'll paste this into GitHub in the next step</p>
              </div>

              {groups.length > 0 && (
                <div style={S.row}>
                  <label style={S.label}>ASSIGN TO GROUPS (optional)</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {groups.map(g => (
                      <button
                        key={g.id}
                        onClick={() => toggleGroup(g.id)}
                        style={{
                          padding: "4px 10px", borderRadius: "var(--radius)", cursor: "pointer",
                          fontSize: "11px", fontFamily: "var(--mono)",
                          border: selectedGroups.includes(g.id) ? "1px solid var(--accent)" : "1px solid var(--border)",
                          background: selectedGroups.includes(g.id) ? "rgba(255,160,0,0.1)" : "transparent",
                          color: selectedGroups.includes(g.id) ? "var(--accent)" : "var(--text-2)",
                        }}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {validateResult && !validateResult.ok && (
                <p style={{ color: "var(--red, #f87171)", fontSize: "12px", marginTop: 0 }}>
                  {validateResult.error}
                </p>
              )}
              {error && <p style={{ color: "var(--red, #f87171)", fontSize: "12px", marginTop: 0 }}>{error}</p>}
            </>
          )}

          {step === 2 && (
            <>
              <p style={{ fontSize: "12px", color: "var(--text-2)", marginBottom: "16px", marginTop: 0 }}>
                Token verified ✓ — now configure the webhook on GitHub.
              </p>

              <div style={S.row}>
                <label style={S.label}>PAYLOAD URL</label>
                <div style={S.code}>
                  <span style={{ flex: 1 }}>{WEBHOOK_URL}</span>
                  <CopyButton text={WEBHOOK_URL} />
                </div>
              </div>

              <div style={S.row}>
                <label style={S.label}>SECRET</label>
                <div style={S.code}>
                  <span style={{ flex: 1 }}>{secret}</span>
                  <CopyButton text={secret} />
                </div>
              </div>

              <div style={{ ...S.row, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px" }}>
                <p style={{ margin: "0 0 8px", fontSize: "11px", color: "var(--text-2)", letterSpacing: "0.04em" }}>IN GITHUB → SETTINGS → WEBHOOKS → ADD WEBHOOK:</p>
                <ol style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--text-2)", lineHeight: "1.8" }}>
                  <li>Paste the Payload URL above</li>
                  <li>Set Content type to <span style={{ color: "var(--text)", fontFamily: "var(--mono)" }}>application/json</span></li>
                  <li>Paste the Secret above</li>
                  <li>Select events: <span style={{ color: "var(--text)" }}>Pushes</span> and <span style={{ color: "var(--text)" }}>Pull requests</span></li>
                  <li>Click <span style={{ color: "var(--text)" }}>Add webhook</span></li>
                </ol>
              </div>

              {error && <p style={{ color: "var(--red, #f87171)", fontSize: "12px" }}>{error}</p>}
            </>
          )}

          {step === 3 && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: "32px", marginBottom: "12px" }}>✓</div>
              <p style={{ fontSize: "14px", color: "var(--text)", marginBottom: "6px" }}>
                {repoName} connected
              </p>
              <p style={{ fontSize: "12px", color: "var(--text-3)" }}>
                Custos will scan it on the next push or pull request.
              </p>
            </div>
          )}
        </div>

        <div style={S.footer}>
          {step === 1 && (
            <>
              <button onClick={onClose} style={S.btn()}>CANCEL</button>
              <button
                onClick={handleValidate}
                disabled={!repoName.trim() || !token || validating}
                style={{ ...S.btn("primary"), opacity: (!repoName.trim() || !token || validating) ? 0.5 : 1 }}
              >
                {validating ? "VERIFYING..." : "VERIFY ACCESS →"}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button onClick={() => setStep(1)} style={S.btn()}>← BACK</button>
              <button onClick={handleSave} disabled={saving} style={{ ...S.btn("primary"), opacity: saving ? 0.5 : 1 }}>
                {saving ? "SAVING..." : "I'VE ADDED THE WEBHOOK →"}
              </button>
            </>
          )}
          {step === 3 && (
            <button onClick={onClose} style={S.btn("primary")}>DONE</button>
          )}
        </div>
      </div>
    </div>
  );
}
