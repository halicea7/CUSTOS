import React, { useEffect, useState } from "react";
import { useAuth } from "../App.jsx";
import {
  getUsers, createUser, updateUserRole, deleteUser,
  changePassword, getConfig, updateConfig, testOllama,
  getGitHubConfig, updateGitHubConfig, testGitHubToken,
} from "../api/settings.js";

// ── Shared primitives ──────────────────────────────────────────────────────────

function SectionBox({ title, subtitle, children }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", marginBottom: "20px" }}>
      <div style={{ padding: "10px 18px", background: "var(--bg-3)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "baseline", gap: "10px" }}>
        <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", color: "var(--text-2)" }}>{title}</span>
        {subtitle && <span style={{ fontSize: "11px", color: "var(--text-3)" }}>{subtitle}</span>}
      </div>
      <div style={{ padding: "20px 18px", background: "var(--bg-2)" }}>{children}</div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "5px" }}>
        <label style={{ fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.12em" }}>{label}</label>
        {hint && <span style={{ fontSize: "10px", color: "var(--text-3)", fontStyle: "italic" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "8px 10px",
  background: "var(--bg-3)", border: "1px solid var(--border)",
  borderRadius: "var(--radius)", color: "var(--text)",
  fontFamily: "var(--mono)", fontSize: "12px", outline: "none",
  transition: "border-color 0.15s",
};

function Input({ value, onChange, type = "text", placeholder, min }) {
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder} min={min}
      style={inputStyle}
      onFocus={e => e.target.style.borderColor = "var(--border-2)"}
      onBlur={e => e.target.style.borderColor = "var(--border)"}
    />
  );
}

function Toggle({ value, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        display: "flex", alignItems: "center", gap: "10px",
        background: "none", border: "none", cursor: "pointer", padding: 0,
      }}
    >
      <div style={{
        width: "36px", height: "20px", borderRadius: "10px",
        background: value ? "var(--accent)" : "var(--border-2)",
        position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}>
        <div style={{
          position: "absolute", top: "3px",
          left: value ? "19px" : "3px",
          width: "14px", height: "14px",
          borderRadius: "50%", background: value ? "#0a0c0f" : "var(--text-3)",
          transition: "left 0.2s",
        }} />
      </div>
      {label && <span style={{ fontSize: "12px", color: "var(--text-2)" }}>{label}</span>}
    </button>
  );
}

function Btn({ onClick, disabled, children, variant = "default", small }) {
  const colors = {
    default: { bg: "var(--bg-3)", border: "var(--border)", color: "var(--text-2)", hover: "var(--bg-4)" },
    primary: { bg: "var(--accent-dim)", border: "var(--accent)", color: "var(--accent)", hover: "rgba(240,165,0,0.2)" },
    danger:  { bg: "rgba(248,81,73,0.08)", border: "rgba(248,81,73,0.3)", color: "#f85149", hover: "rgba(248,81,73,0.15)" },
    green:   { bg: "rgba(63,185,80,0.08)", border: "rgba(63,185,80,0.3)", color: "#3fb950", hover: "rgba(63,185,80,0.15)" },
  };
  const c = colors[variant];
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? "4px 10px" : "8px 16px",
      background: c.bg, border: `1px solid ${c.border}`,
      borderRadius: "var(--radius)", color: c.color,
      fontSize: small ? "10px" : "11px", fontWeight: 600, letterSpacing: "0.06em",
      cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--mono)",
      opacity: disabled ? 0.5 : 1, transition: "all 0.15s", whiteSpace: "nowrap",
    }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = c.hover; }}
      onMouseLeave={e => { if (!disabled) e.currentTarget.style.background = c.bg; }}
    >{children}</button>
  );
}

function Feedback({ msg, type }) {
  if (!msg) return null;
  const c = type === "success"
    ? { bg: "var(--green-dim)", border: "#3fb95033", color: "var(--green)" }
    : { bg: "var(--red-dim)", border: "#f8514933", color: "var(--red)" };
  return (
    <div style={{ marginTop: "10px", padding: "8px 12px", background: c.bg, border: `1px solid ${c.border}`, borderRadius: "var(--radius)", color: c.color, fontSize: "12px" }}>
      {msg}
    </div>
  );
}

function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: "2px", marginBottom: "24px", borderBottom: "1px solid var(--border)" }}>
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)} style={{
          padding: "8px 16px", background: "none", border: "none",
          borderBottom: active === t.key ? "2px solid var(--accent)" : "2px solid transparent",
          color: active === t.key ? "var(--accent)" : "var(--text-2)",
          fontSize: "11px", fontWeight: 600, letterSpacing: "0.08em",
          cursor: "pointer", fontFamily: "var(--mono)", marginBottom: "-1px",
          transition: "color 0.15s",
        }}>{t.label}</button>
      ))}
    </div>
  );
}

// ── Role badge (clickable to cycle) ───────────────────────────────────────────

const ROLES = ["analyst", "admin"];
const ROLE_COLORS = {
  admin:   { color: "#f0a500", bg: "rgba(240,165,0,0.1)", border: "rgba(240,165,0,0.3)" },
  analyst: { color: "#388bfd", bg: "rgba(56,139,253,0.1)", border: "rgba(56,139,253,0.3)" },
};

function RoleBadge({ role, onClick, clickable }) {
  const c = ROLE_COLORS[role] || { color: "var(--text-3)", bg: "var(--bg-3)", border: "var(--border)" };
  return (
    <span
      onClick={onClick}
      title={clickable ? "Click to cycle role" : undefined}
      style={{
        display: "inline-flex", alignItems: "center", gap: "5px",
        padding: "2px 9px", borderRadius: "3px",
        fontSize: "10px", fontWeight: 600, letterSpacing: "0.08em",
        color: c.color, background: c.bg, border: `1px solid ${c.border}`,
        cursor: clickable ? "pointer" : "default",
        userSelect: "none", transition: "all 0.15s",
      }}
      onMouseEnter={e => { if (clickable) e.currentTarget.style.opacity = "0.75"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
    >
      {role.toUpperCase()}
      {clickable && <span style={{ opacity: 0.6, fontSize: "9px" }}>⇅</span>}
    </span>
  );
}

// ── Account section ────────────────────────────────────────────────────────────

function AccountSection({ username }) {
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm: "" });
  const [loading, setLoading] = useState(false);
  const [fb, setFb] = useState(null);

  const handle = async (e) => {
    e.preventDefault();
    if (form.new_password !== form.confirm) { setFb({ msg: "New passwords do not match", type: "error" }); return; }
    if (form.new_password.length < 8) { setFb({ msg: "Password must be at least 8 characters", type: "error" }); return; }
    setLoading(true); setFb(null);
    try {
      await changePassword({ current_password: form.current_password, new_password: form.new_password });
      setFb({ msg: "Password changed successfully", type: "success" });
      setForm({ current_password: "", new_password: "", confirm: "" });
    } catch (e) {
      setFb({ msg: e.response?.data?.detail || "Failed to change password", type: "error" });
    } finally { setLoading(false); }
  };

  return (
    <SectionBox title="CHANGE PASSWORD">
      <div style={{ maxWidth: "400px" }}>
        <div style={{ marginBottom: "16px", fontSize: "12px", color: "var(--text-3)" }}>
          Logged in as <span style={{ color: "var(--text-2)" }}>{username}</span>
        </div>
        <form onSubmit={handle}>
          <Field label="CURRENT PASSWORD"><Input type="password" value={form.current_password} onChange={e => setForm(f => ({ ...f, current_password: e.target.value }))} /></Field>
          <Field label="NEW PASSWORD"><Input type="password" value={form.new_password} onChange={e => setForm(f => ({ ...f, new_password: e.target.value }))} /></Field>
          <Field label="CONFIRM NEW PASSWORD"><Input type="password" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} /></Field>
          <Btn variant="primary" disabled={loading} onClick={handle}>{loading ? "SAVING..." : "UPDATE PASSWORD"}</Btn>
        </form>
        <Feedback {...(fb || {})} />
      </div>
    </SectionBox>
  );
}

// ── Users section ──────────────────────────────────────────────────────────────

function UsersSection({ currentUsername }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fb, setFb] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "analyst" });
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // pendingRoles: { [userId]: newRole } — unsaved role changes
  const [pendingRoles, setPendingRoles] = useState({});
  const [savingRole, setSavingRole] = useState(null);

  useEffect(() => {
    getUsers().then(setUsers).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const cycleRole = (user) => {
    if (user.username === currentUsername) return;
    const currentRole = pendingRoles[user.id] ?? user.role;
    const nextRole = ROLES[(ROLES.indexOf(currentRole) + 1) % ROLES.length];
    setPendingRoles(p => ({ ...p, [user.id]: nextRole }));
  };

  const cancelRole = (userId) => {
    setPendingRoles(p => { const n = { ...p }; delete n[userId]; return n; });
  };

  const saveRole = async (user) => {
    const newRole = pendingRoles[user.id];
    if (!newRole) return;
    setSavingRole(user.id);
    setFb(null);
    try {
      const updated = await updateUserRole(user.id, newRole);
      setUsers(prev => prev.map(u => u.id === updated.id ? updated : u));
      cancelRole(user.id);
      setFb({ msg: `${user.username} is now ${updated.role}`, type: "success" });
    } catch (e) {
      setFb({ msg: e.response?.data?.detail || "Failed to update role", type: "error" });
    } finally { setSavingRole(null); }
  };

  const handleCreate = async (e) => {
    e.preventDefault(); setFb(null);
    try {
      const u = await createUser(newUser);
      setUsers(prev => [...prev, u]);
      setNewUser({ username: "", password: "", role: "analyst" });
      setCreating(false);
      setFb({ msg: `User '${u.username}' created`, type: "success" });
    } catch (e) {
      setFb({ msg: e.response?.data?.detail || "Failed to create user", type: "error" });
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteUser(id);
      setUsers(prev => prev.filter(u => u.id !== id));
      setDeleteConfirm(null);
      setFb({ msg: "User deleted", type: "success" });
    } catch (e) {
      setFb({ msg: e.response?.data?.detail || "Failed to delete user", type: "error" });
    }
  };

  return (
    <>
      <SectionBox title="USER ACCOUNTS">
        {loading ? <span style={{ color: "var(--text-3)", fontSize: "12px" }}>Loading...</span> : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 140px auto", gap: "12px", padding: "4px 12px" }}>
              {["USERNAME", "ROLE", "CREATED", ""].map(h => (
                <span key={h} style={{ fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.1em", fontWeight: 600 }}>{h}</span>
              ))}
            </div>
            {users.map(u => {
              const isSelf = u.username === currentUsername;
              const pending = pendingRoles[u.id];
              const displayRole = pending ?? u.role;
              const isDirty = !!pending;
              return (
                <div key={u.id} style={{
                  display: "grid", gridTemplateColumns: "1fr 160px 140px auto",
                  gap: "12px", alignItems: "center",
                  padding: "10px 12px",
                  background: isDirty ? "rgba(240,165,0,0.03)" : "var(--bg-3)",
                  border: `1px solid ${isDirty ? "rgba(240,165,0,0.2)" : "var(--border)"}`,
                  borderRadius: "var(--radius)", transition: "all 0.15s",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "var(--text)" }}>{u.username}</span>
                    {isSelf && <span style={{ fontSize: "10px", color: "var(--text-3)", padding: "0 5px", border: "1px solid var(--border)", borderRadius: "3px" }}>you</span>}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <RoleBadge role={displayRole} clickable={!isSelf} onClick={() => cycleRole(u)} />
                    {isDirty && (
                      <span style={{ fontSize: "10px", color: "var(--text-3)", fontStyle: "italic" }}>
                        was {u.role}
                      </span>
                    )}
                  </div>

                  <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
                    {new Date(u.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>

                  <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                    {isDirty ? (
                      <>
                        <Btn variant="primary" small disabled={savingRole === u.id} onClick={() => saveRole(u)}>
                          {savingRole === u.id ? "..." : "Save"}
                        </Btn>
                        <Btn small onClick={() => cancelRole(u.id)}>Cancel</Btn>
                      </>
                    ) : !isSelf && (
                      deleteConfirm === u.id ? (
                        <>
                          <Btn variant="danger" small onClick={() => handleDelete(u.id)}>Confirm</Btn>
                          <Btn small onClick={() => setDeleteConfirm(null)}>Cancel</Btn>
                        </>
                      ) : (
                        <Btn variant="danger" small onClick={() => setDeleteConfirm(u.id)}>Delete</Btn>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Feedback {...(fb || {})} />
      </SectionBox>

      <SectionBox title="CREATE USER">
        {!creating ? (
          <Btn variant="green" onClick={() => setCreating(true)}>+ NEW USER</Btn>
        ) : (
          <form onSubmit={handleCreate} style={{ maxWidth: "400px" }}>
            <Field label="USERNAME"><Input value={newUser.username} onChange={e => setNewUser(f => ({ ...f, username: e.target.value }))} placeholder="username" /></Field>
            <Field label="PASSWORD"><Input type="password" value={newUser.password} onChange={e => setNewUser(f => ({ ...f, password: e.target.value }))} placeholder="min 8 characters" /></Field>
            <Field label="ROLE">
              <select value={newUser.role} onChange={e => setNewUser(f => ({ ...f, role: e.target.value }))}
                style={{ ...inputStyle, cursor: "pointer" }}
                onFocus={e => e.target.style.borderColor = "var(--border-2)"}
                onBlur={e => e.target.style.borderColor = "var(--border)"}
              >
                <option value="analyst">analyst</option>
                <option value="admin">admin</option>
              </select>
            </Field>
            <div style={{ display: "flex", gap: "8px" }}>
              <Btn variant="primary" onClick={handleCreate}>CREATE</Btn>
              <Btn onClick={() => { setCreating(false); setNewUser({ username: "", password: "", role: "analyst" }); }}>Cancel</Btn>
            </div>
          </form>
        )}
      </SectionBox>
    </>
  );
}

// ── Analysis config section ────────────────────────────────────────────────────

function ConfigSection() {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fb, setFb] = useState(null);
  const [ollamaTest, setOllamaTest] = useState(null); // null | "testing" | { ok, error, models }

  const handleTestOllama = async () => {
    setOllamaTest("testing");
    try {
      const result = await testOllama(draft.ollama_base_url);
      setOllamaTest(result);
    } catch {
      setOllamaTest({ ok: false, error: "Request failed", models: [] });
    }
  };

  useEffect(() => {
    getConfig()
      .then(c => { setCfg(c); setDraft(c); })
      .catch(() => setFb({ msg: "Failed to load config", type: "error" }))
      .finally(() => setLoading(false));
  }, []);

  const set = (key) => (e) => {
    const val = e.target ? e.target.value : e; // e can be a direct value (toggle)
    setDraft(d => ({ ...d, [key]: val }));
  };

  const handleSave = async () => {
    setSaving(true); setFb(null);
    try {
      const updated = await updateConfig({
        ollama_base_url: draft.ollama_base_url,
        ollama_model: draft.ollama_model,
        ollama_think: draft.ollama_think,
        ollama_num_ctx: parseInt(draft.ollama_num_ctx) || 0,
        llm_max_content_chars: parseInt(draft.llm_max_content_chars),
        max_file_size_kb: parseInt(draft.max_file_size_kb),
        max_files_per_repo: parseInt(draft.max_files_per_repo),
        access_token_expire_minutes: parseInt(draft.access_token_expire_minutes),
        worker_max_jobs: parseInt(draft.worker_max_jobs),
        worker_job_timeout: parseInt(draft.worker_job_timeout),
      });
      setCfg(updated); setDraft(updated);
      setFb({ msg: "Configuration saved", type: "success" });
    } catch (e) {
      setFb({ msg: e.response?.data?.detail || "Failed to save", type: "error" });
    } finally { setSaving(false); }
  };

  const dirty = draft && cfg && JSON.stringify(draft) !== JSON.stringify(cfg);

  if (loading) return <SectionBox title="ANALYSIS CONFIGURATION"><span style={{ color: "var(--text-3)", fontSize: "12px" }}>Loading...</span></SectionBox>;

  return (
    <>
      {/* Ollama */}
      <SectionBox title="OLLAMA" subtitle="— takes effect on next job">
        <div style={{ maxWidth: "520px" }}>
          <Field label="BASE URL">
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <Input
                  value={draft?.ollama_base_url || ""}
                  onChange={e => { set("ollama_base_url")(e); setOllamaTest(null); }}
                  placeholder="http://localhost:11434"
                />
              </div>
              <Btn
                small
                disabled={ollamaTest === "testing" || !draft?.ollama_base_url}
                onClick={handleTestOllama}
                variant={ollamaTest && ollamaTest !== "testing" ? (ollamaTest.ok ? "green" : "danger") : "default"}
              >
                {ollamaTest === "testing" ? "TESTING..." : "TEST"}
              </Btn>
            </div>
            {ollamaTest && ollamaTest !== "testing" && (
              <div style={{
                marginTop: "8px", padding: "8px 12px",
                background: ollamaTest.ok ? "var(--green-dim)" : "var(--red-dim)",
                border: `1px solid ${ollamaTest.ok ? "#3fb95033" : "#f8514933"}`,
                borderRadius: "var(--radius)", fontSize: "11px",
              }}>
                {ollamaTest.ok ? (
                  <div>
                    <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ Connected</span>
                    {ollamaTest.models.length > 0 && (
                      <div style={{ marginTop: "6px", color: "var(--text-3)" }}>
                        <span style={{ color: "var(--text-2)" }}>Available models: </span>
                        {ollamaTest.models.map(m => (
                          <span
                            key={m}
                            onClick={() => setDraft(d => ({ ...d, ollama_model: m }))}
                            title="Click to use this model"
                            style={{
                              display: "inline-block", margin: "2px 4px 2px 0",
                              padding: "1px 8px", borderRadius: "3px",
                              background: draft?.ollama_model === m ? "rgba(240,165,0,0.15)" : "var(--bg-3)",
                              border: `1px solid ${draft?.ollama_model === m ? "var(--accent)" : "var(--border)"}`,
                              color: draft?.ollama_model === m ? "var(--accent)" : "var(--text-2)",
                              cursor: "pointer", fontFamily: "var(--mono)",
                              transition: "all 0.12s",
                            }}
                          >{m}</span>
                        ))}
                      </div>
                    )}
                    {ollamaTest.models.length === 0 && (
                      <span style={{ color: "var(--text-3)", marginLeft: "8px" }}>— no models pulled yet</span>
                    )}
                  </div>
                ) : (
                  <span style={{ color: "var(--red)" }}>✗ {ollamaTest.error}</span>
                )}
              </div>
            )}
          </Field>
          <Field label="MODEL"><Input value={draft?.ollama_model || ""} onChange={set("ollama_model")} placeholder="e.g. qwen3:4b, llama3:8b, mistral" /></Field>
          <Field label="CHAIN-OF-THOUGHT (think)" hint="— enable for models that support &lt;think&gt; blocks">
            <div style={{ paddingTop: "4px" }}>
              <Toggle value={!!draft?.ollama_think} onChange={v => setDraft(d => ({ ...d, ollama_think: v }))} label={draft?.ollama_think ? "Enabled" : "Disabled"} />
            </div>
          </Field>
          <Field label="CONTEXT WINDOW (num_ctx)" hint="— tokens Ollama allocates; 0 = use model/Modelfile default">
            <Input type="number" min="0" step="1024" value={draft?.ollama_num_ctx ?? 0} onChange={set("ollama_num_ctx")} placeholder="0" />
            {draft?.ollama_num_ctx > 0 && (
              <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "4px" }}>
                Set to {Number(draft.ollama_num_ctx).toLocaleString()} tokens — override active
              </div>
            )}
            {!(draft?.ollama_num_ctx > 0) && (
              <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "4px" }}>
                Using model default (Modelfile or Ollama built-in)
              </div>
            )}
          </Field>
        </div>
      </SectionBox>

      {/* LLM context */}
      <SectionBox title="LLM CONTEXT" subtitle="— takes effect on next job">
        <div style={{ maxWidth: "520px" }}>
          <Field label="MAX CONTENT CHARS" hint="— approximate token budget (1 token ≈ 4 chars)">
            <Input type="number" min="10000" value={draft?.llm_max_content_chars || ""} onChange={set("llm_max_content_chars")} />
          </Field>
          <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "-6px", marginBottom: "14px" }}>
            Current: ~{Math.round((draft?.llm_max_content_chars || 0) / 4).toLocaleString()} tokens
          </div>
        </div>
      </SectionBox>

      {/* Scanning */}
      <SectionBox title="SCANNING" subtitle="— takes effect on next job">
        <div style={{ maxWidth: "520px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Field label="MAX FILE SIZE (KB)"><Input type="number" min="1" value={draft?.max_file_size_kb || ""} onChange={set("max_file_size_kb")} /></Field>
            <Field label="MAX FILES PER REPO"><Input type="number" min="1" value={draft?.max_files_per_repo || ""} onChange={set("max_files_per_repo")} /></Field>
          </div>
        </div>
      </SectionBox>

      {/* Session */}
      <SectionBox title="SESSION" subtitle="— takes effect on next login">
        <div style={{ maxWidth: "520px" }}>
          <Field label="TOKEN EXPIRY (MINUTES)">
            <Input type="number" min="1" value={draft?.access_token_expire_minutes || ""} onChange={set("access_token_expire_minutes")} />
          </Field>
          <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "-6px", marginBottom: "14px" }}>
            {draft?.access_token_expire_minutes >= 60
              ? `~${(draft.access_token_expire_minutes / 60).toFixed(1)}h per session`
              : `${draft?.access_token_expire_minutes}min per session`}
          </div>
        </div>
      </SectionBox>

      {/* Worker */}
      <SectionBox title="WORKER" subtitle="— requires worker restart">
        <div style={{ maxWidth: "520px" }}>
          <div style={{ marginBottom: "14px", padding: "8px 12px", background: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: "11px", color: "var(--text-3)" }}>
            These settings are persisted to the database but only read by the worker process on startup.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Field label="MAX CONCURRENT JOBS"><Input type="number" min="1" value={draft?.worker_max_jobs || ""} onChange={set("worker_max_jobs")} /></Field>
            <Field label="JOB TIMEOUT (SECONDS)"><Input type="number" min="60" value={draft?.worker_job_timeout || ""} onChange={set("worker_job_timeout")} /></Field>
          </div>
        </div>
      </SectionBox>

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Btn variant={dirty ? "primary" : "default"} disabled={saving || !dirty} onClick={handleSave}>
          {saving ? "SAVING..." : dirty ? "SAVE ALL CHANGES" : "NO CHANGES"}
        </Btn>
        {dirty && <span style={{ fontSize: "11px", color: "var(--accent)" }}>Unsaved changes</span>}
      </div>
      <Feedback {...(fb || {})} />
    </>
  );
}

// ── GitHub section ────────────────────────────────────────────────────────────

function SecretField({ label, preview, isSet, onSave, hint }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [fb, setFb] = useState(null);

  const handleSave = async () => {
    if (!value.trim()) return;
    setSaving(true); setFb(null);
    try {
      await onSave(value.trim());
      setEditing(false); setValue("");
      setFb({ msg: "Saved", type: "success" });
    } catch (e) {
      setFb({ msg: e.response?.data?.detail || "Failed to save", type: "error" });
    } finally { setSaving(false); }
  };

  return (
    <div style={{ marginBottom: "20px" }}>
      <div style={{ fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.12em", marginBottom: "8px" }}>
        {label}
        {hint && <span style={{ marginLeft: "8px", fontStyle: "italic" }}>{hint}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
        <div style={{
          flex: 1, padding: "8px 12px",
          background: "var(--bg-3)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", fontFamily: "var(--mono)", fontSize: "12px",
          display: "flex", alignItems: "center", gap: "10px",
        }}>
          {isSet ? (
            <>
              <span style={{ color: "var(--green)", fontSize: "10px", fontWeight: 600 }}>● SET</span>
              <span style={{ color: "var(--text-3)", letterSpacing: "0.05em" }}>{preview}</span>
            </>
          ) : (
            <span style={{ color: "var(--text-3)", fontStyle: "italic" }}>not configured</span>
          )}
        </div>
        <Btn small onClick={() => { setEditing(e => !e); setValue(""); setFb(null); }}>
          {editing ? "Cancel" : isSet ? "ROTATE" : "SET"}
        </Btn>
      </div>
      {editing && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <input
              type="password"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="Paste new value..."
              autoFocus
              style={{ ...inputStyle, width: "100%" }}
              onFocus={e => e.target.style.borderColor = "var(--border-2)"}
              onBlur={e => e.target.style.borderColor = "var(--border)"}
              onKeyDown={e => e.key === "Enter" && handleSave()}
            />
          </div>
          <Btn variant="primary" small disabled={saving || !value.trim()} onClick={handleSave}>
            {saving ? "..." : "SAVE"}
          </Btn>
        </div>
      )}
      <Feedback {...(fb || {})} />
    </div>
  );
}

function GitHubSection() {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tokenTest, setTokenTest] = useState(null);

  useEffect(() => {
    getGitHubConfig().then(setCfg).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleTestToken = async () => {
    setTokenTest("testing");
    try {
      const result = await testGitHubToken();
      setTokenTest(result);
    } catch {
      setTokenTest({ ok: false, error: "Request failed", login: null, scopes: [] });
    }
  };

  const saveSecret = async (value) => {
    const updated = await updateGitHubConfig({ webhook_secret: value });
    setCfg(updated);
  };

  const saveToken = async (value) => {
    const updated = await updateGitHubConfig({ token: value });
    setCfg(updated);
    setTokenTest(null);
  };

  if (loading) return <SectionBox title="GITHUB"><span style={{ fontSize: "12px", color: "var(--text-3)" }}>Loading...</span></SectionBox>;

  return (
    <>
      {/* Webhook */}
      <SectionBox title="WEBHOOK">
        <div style={{ maxWidth: "560px" }}>
          <div style={{ marginBottom: "20px", padding: "12px 14px", background: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: "12px", lineHeight: 1.8 }}>
            <div style={{ color: "var(--text-2)", marginBottom: "8px", fontWeight: 500 }}>Setup steps</div>
            <ol style={{ paddingLeft: "16px", color: "var(--text-3)", display: "flex", flexDirection: "column", gap: "4px" }}>
              <li>Go to your GitHub repo → <span style={{ color: "var(--text-2)" }}>Settings → Webhooks → Add webhook</span></li>
              <li>Payload URL: <span style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>https://&lt;your-server&gt;/webhook/github</span></li>
              <li>Content type: <span style={{ color: "var(--text-2)", fontFamily: "var(--mono)" }}>application/json</span></li>
              <li>Events: <span style={{ color: "var(--text-2)" }}>Pushes</span> and <span style={{ color: "var(--text-2)" }}>Pull requests</span></li>
              <li>Generate a strong secret and paste it below + into the GitHub form</li>
            </ol>
          </div>
          <SecretField
            label="WEBHOOK SECRET"
            hint="— used to validate HMAC-SHA256 signatures on incoming payloads"
            isSet={cfg?.webhook_secret_set}
            preview={cfg?.webhook_secret_preview}
            onSave={saveSecret}
          />
        </div>
      </SectionBox>

      {/* Token */}
      <SectionBox title="GITHUB TOKEN">
        <div style={{ maxWidth: "560px" }}>
          <div style={{ marginBottom: "20px", padding: "12px 14px", background: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: "12px", lineHeight: 1.8 }}>
            <div style={{ color: "var(--text-2)", marginBottom: "8px", fontWeight: 500 }}>Required permissions</div>
            <div style={{ color: "var(--text-3)", display: "flex", flexDirection: "column", gap: "3px" }}>
              <div><span style={{ color: "var(--green)", marginRight: "8px" }}>✓</span><span style={{ fontFamily: "var(--mono)", color: "var(--text-2)" }}>repo</span> — read access to clone private repos</div>
              <div><span style={{ color: "var(--green)", marginRight: "8px" }}>✓</span><span style={{ fontFamily: "var(--mono)", color: "var(--text-2)" }}>checks:write</span> — post check run status back to PRs</div>
              <div style={{ marginTop: "4px", fontSize: "11px" }}>Create a fine-grained PAT or classic token with these scopes at <span style={{ color: "var(--accent)" }}>github.com/settings/tokens</span></div>
            </div>
          </div>

          <SecretField
            label="PERSONAL ACCESS TOKEN"
            hint="— used to post check runs and clone private repos"
            isSet={cfg?.token_set}
            preview={cfg?.token_preview}
            onSave={saveToken}
          />

          {/* Test token */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Btn
              small
              disabled={!cfg?.token_set || tokenTest === "testing"}
              variant={tokenTest && tokenTest !== "testing" ? (tokenTest.ok ? "green" : "danger") : "default"}
              onClick={handleTestToken}
            >
              {tokenTest === "testing" ? "TESTING..." : "TEST TOKEN"}
            </Btn>
            {!cfg?.token_set && <span style={{ fontSize: "11px", color: "var(--text-3)" }}>Set a token to enable testing</span>}
          </div>

          {tokenTest && tokenTest !== "testing" && (
            <div style={{
              marginTop: "10px", padding: "10px 14px",
              background: tokenTest.ok ? "var(--green-dim)" : "var(--red-dim)",
              border: `1px solid ${tokenTest.ok ? "#3fb95033" : "#f8514933"}`,
              borderRadius: "var(--radius)", fontSize: "12px",
            }}>
              {tokenTest.ok ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div>
                    <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ Valid</span>
                    {tokenTest.login && <span style={{ color: "var(--text-2)", marginLeft: "8px" }}>authenticated as <span style={{ fontFamily: "var(--mono)" }}>{tokenTest.login}</span></span>}
                  </div>
                  {tokenTest.scopes.length > 0 && (
                    <div style={{ color: "var(--text-3)" }}>
                      <span style={{ color: "var(--text-2)" }}>Scopes: </span>
                      {tokenTest.scopes.map(s => {
                        const needed = ["repo", "checks:write", "checks", "public_repo"];
                        const isRelevant = needed.some(n => s.includes(n));
                        return (
                          <span key={s} style={{
                            display: "inline-block", margin: "1px 4px 1px 0",
                            padding: "0 7px", borderRadius: "3px",
                            fontFamily: "var(--mono)", fontSize: "11px",
                            background: isRelevant ? "rgba(63,185,80,0.1)" : "var(--bg-4)",
                            border: `1px solid ${isRelevant ? "#3fb95033" : "var(--border)"}`,
                            color: isRelevant ? "var(--green)" : "var(--text-3)",
                          }}>{s}</span>
                        );
                      })}
                    </div>
                  )}
                  {tokenTest.scopes.length === 0 && (
                    <div style={{ color: "var(--text-3)", fontSize: "11px" }}>Fine-grained token — scopes not returned by API (this is normal)</div>
                  )}
                </div>
              ) : (
                <span style={{ color: "var(--red)" }}>✗ {tokenTest.error}</span>
              )}
            </div>
          )}
        </div>
      </SectionBox>
    </>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const tabs = [
    { key: "account", label: "ACCOUNT" },
    ...(isAdmin ? [
      { key: "users",   label: "USERS" },
      { key: "config",  label: "ANALYSIS" },
      { key: "github",  label: "GITHUB" },
    ] : []),
  ];
  const [tab, setTab] = useState("account");

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "18px", fontWeight: 600, color: "var(--text)", fontFamily: "var(--sans)", letterSpacing: "-0.02em" }}>
          Settings
        </h1>
        {!isAdmin && (
          <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-3)" }}>
            User management and analysis config are restricted to admins.
          </div>
        )}
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "account" && <AccountSection username={user?.username} />}
      {tab === "users"   && isAdmin && <UsersSection currentUsername={user?.username} />}
      {tab === "config"  && isAdmin && <ConfigSection />}
      {tab === "github"  && isAdmin && <GitHubSection />}
    </div>
  );
}
