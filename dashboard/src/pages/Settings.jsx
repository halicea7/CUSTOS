import React, { useEffect, useState } from "react";
import { useAuth } from "../App.jsx";
import { useTheme } from "../App.jsx";
import {
  getUsers, createUser, updateUserRole, deleteUser,
  changePassword, getConfig, updateConfig, testOllama, testResponses,
} from "../api/settings.js";
import { Btn, Avatar, RoleBadge } from "../components/atoms.jsx";
import { PageHeader, PageWrap, SectionCard, Field, TextInput, SelectInput, Toggle, Tabs, Feedback } from "../components/ui.jsx";
import { errorMessage } from "../api/errors.js";

// ── Account ───────────────────────────────────────────────────────────────────

function AccountTab({ theme, username }) {
  const [form,    setForm]    = useState({ current_password: "", new_password: "", confirm: "" });
  const [loading, setLoading] = useState(false);
  const [fb,      setFb]      = useState(null);
  const t = theme;

  const handle = async (e) => {
    e?.preventDefault();
    if (form.new_password !== form.confirm) return setFb({ msg: "New passwords do not match", type: "error" });
    if (form.new_password.length < 8) return setFb({ msg: "Password must be at least 8 characters", type: "error" });
    setLoading(true); setFb(null);
    try {
      await changePassword({ current_password: form.current_password, new_password: form.new_password });
      setFb({ msg: "Password changed successfully", type: "success" });
      setForm({ current_password: "", new_password: "", confirm: "" });
    } catch (e) {
      setFb({ msg: errorMessage(e, "Failed to change password"), type: "error" });
    } finally { setLoading(false); }
  };

  return (
    <SectionCard theme={t} title="Change password">
      <div style={{ maxWidth: 400 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <Avatar theme={t} name={username} size={36} />
          <div>
            <div style={{ fontSize: 13.5, color: t.c.text, fontWeight: 600 }}>{username}</div>
            <div style={{ fontSize: 12, color: t.c.text3 }}>Signed in</div>
          </div>
        </div>
        <Field theme={t} label="Current password">
          <TextInput theme={t} type="password" value={form.current_password}
            onChange={e => setForm(f => ({ ...f, current_password: e.target.value }))} />
        </Field>
        <Field theme={t} label="New password">
          <TextInput theme={t} type="password" value={form.new_password}
            onChange={e => setForm(f => ({ ...f, new_password: e.target.value }))} />
        </Field>
        <Field theme={t} label="Confirm new password">
          <TextInput theme={t} type="password" value={form.confirm}
            onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
            onKeyDown={e => e.key === "Enter" && handle()} />
        </Field>
        <Btn theme={t} variant="primary" onClick={handle} disabled={loading}>
          {loading ? "Saving…" : "Update password"}
        </Btn>
        <Feedback theme={t} {...(fb || {})} />
      </div>
    </SectionCard>
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────

const ROLES = ["analyst", "admin"];

function UsersTab({ theme, currentUser }) {
  const [users,       setUsers]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [fb,          setFb]          = useState(null);
  const [creating,    setCreating]    = useState(false);
  const [newUser,     setNewUser]     = useState({ username: "", password: "", role: "analyst" });
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [pendingRoles,  setPendingRoles]  = useState({});
  const [savingRole,    setSavingRole]    = useState(null);
  const t = theme;

  useEffect(() => {
    getUsers().then(setUsers).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const cycleRole = (u) => {
    if (u.username === currentUser) return;
    const cur = pendingRoles[u.id] ?? u.role;
    const next = ROLES[(ROLES.indexOf(cur) + 1) % ROLES.length];
    setPendingRoles(p => ({ ...p, [u.id]: next }));
  };

  const cancelRole = (id) => setPendingRoles(p => { const n = { ...p }; delete n[id]; return n; });

  const saveRole = async (u) => {
    const newRole = pendingRoles[u.id]; if (!newRole) return;
    setSavingRole(u.id); setFb(null);
    try {
      const updated = await updateUserRole(u.id, newRole);
      setUsers(prev => prev.map(x => x.id === updated.id ? updated : x));
      cancelRole(u.id);
      setFb({ msg: `${u.username} is now ${updated.role}`, type: "success" });
    } catch (e) {
      setFb({ msg: errorMessage(e, "Failed to update role"), type: "error" });
    } finally { setSavingRole(null); }
  };

  const handleCreate = async (e) => {
    e?.preventDefault(); setFb(null);
    try {
      const u = await createUser(newUser);
      setUsers(prev => [...prev, u]);
      setNewUser({ username: "", password: "", role: "analyst" });
      setCreating(false);
      setFb({ msg: `User '${u.username}' created`, type: "success" });
    } catch (e) {
      setFb({ msg: errorMessage(e, "Failed to create user"), type: "error" });
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteUser(id);
      setUsers(prev => prev.filter(u => u.id !== id));
      setDeleteConfirm(null);
      setFb({ msg: "User deleted", type: "success" });
    } catch (e) {
      setFb({ msg: errorMessage(e, "Failed to delete user"), type: "error" });
    }
  };

  return (
    <>
      <SectionCard theme={t} title="User accounts" pad={false}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 130px 110px", gap: 12,
          padding: "10px 18px", borderBottom: `1px solid ${t.c.border}`, background: t.c.raised }}>
          {["User", "Role", "Created", ""].map((h, i) => (
            <span key={i} style={{ fontSize: 11, fontWeight: 600, color: t.c.text3,
              letterSpacing: "0.04em", textTransform: "uppercase",
              textAlign: i === 3 ? "right" : "left" }}>{h}</span>
          ))}
        </div>
        {loading ? (
          <div style={{ padding: "20px 18px", color: t.c.text3, fontSize: 13 }}>Loading…</div>
        ) : users.map((u, i) => {
          const isSelf    = u.username === currentUser;
          const pending   = pendingRoles[u.id];
          const dispRole  = pending ?? u.role;
          const isDirty   = !!pending;
          return (
            <div key={u.id} style={{ display: "grid", gridTemplateColumns: "1fr 150px 130px 110px",
              gap: 12, alignItems: "center", padding: "12px 18px",
              borderBottom: i === users.length - 1 ? "none" : `1px solid ${t.c.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar theme={t} name={u.username} size={28} />
                <span style={{ fontSize: 13, color: t.c.text, fontFamily: t.fontMono }}>{u.username}</span>
                {isSelf && (
                  <span style={{ fontSize: 10.5, color: t.c.text3, padding: "1px 6px",
                    border: `1px solid ${t.c.border}`, borderRadius: 4 }}>you</span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <RoleBadge theme={t} role={dispRole} clickable={!isSelf} onClick={() => cycleRole(u)} />
                {isDirty && <span style={{ fontSize: 10.5, color: t.c.text3, fontStyle: "italic" }}>was {u.role}</span>}
              </div>
              <span style={{ fontSize: 12, color: t.c.text3 }}>
                {new Date(u.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </span>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {isDirty ? (
                  <>
                    <Btn theme={t} variant="primary" size="sm" disabled={savingRole === u.id}
                      onClick={() => saveRole(u)}>{savingRole === u.id ? "…" : "Save"}</Btn>
                    <Btn theme={t} size="sm" onClick={() => cancelRole(u.id)}>Cancel</Btn>
                  </>
                ) : !isSelf && (
                  deleteConfirm === u.id ? (
                    <>
                      <Btn theme={t} variant="danger" size="sm" onClick={() => handleDelete(u.id)}>Confirm</Btn>
                      <Btn theme={t} size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Btn>
                    </>
                  ) : (
                    <Btn theme={t} variant="quiet" size="sm" onClick={() => setDeleteConfirm(u.id)}>Delete</Btn>
                  )
                )}
              </div>
            </div>
          );
        })}
        <Feedback theme={t} {...(fb || {})} />
      </SectionCard>

      <SectionCard theme={t} title="Create user">
        {!creating ? (
          <Btn theme={t} variant="success" onClick={() => setCreating(true)}>+ New user</Btn>
        ) : (
          <div style={{ maxWidth: 400 }}>
            <Field theme={t} label="Username">
              <TextInput theme={t} value={newUser.username} mono
                onChange={e => setNewUser(f => ({ ...f, username: e.target.value }))}
                placeholder="username" />
            </Field>
            <Field theme={t} label="Password">
              <TextInput theme={t} type="password" value={newUser.password}
                onChange={e => setNewUser(f => ({ ...f, password: e.target.value }))}
                placeholder="min 8 characters" />
            </Field>
            <Field theme={t} label="Role">
              <SelectInput theme={t} value={newUser.role}
                onChange={e => setNewUser(f => ({ ...f, role: e.target.value }))}
                options={[{ value: "analyst", label: "Analyst" }, { value: "admin", label: "Admin" }]} />
            </Field>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn theme={t} variant="primary" onClick={handleCreate}>Create</Btn>
              <Btn theme={t} onClick={() => { setCreating(false); setNewUser({ username: "", password: "", role: "analyst" }); }}>
                Cancel
              </Btn>
            </div>
          </div>
        )}
        <Feedback theme={t} {...(fb || {})} />
      </SectionCard>
    </>
  );
}

// ── Analysis config ───────────────────────────────────────────────────────────

function AnalysisTab({ theme }) {
  const [cfg,     setCfg]     = useState(null);
  const [draft,   setDraft]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [fb,      setFb]      = useState(null);
  const [ollamaTest, setOllamaTest] = useState(null);
  const [respTest, setRespTest] = useState(null);
  const t = theme;

  useEffect(() => {
    getConfig().then(c => { setCfg(c); setDraft(c); })
      .catch(() => setFb({ msg: "Failed to load config", type: "error" }))
      .finally(() => setLoading(false));
  }, []);

  const set = (key) => (e) => {
    const val = e && e.target ? e.target.value : e;
    setDraft(d => ({ ...d, [key]: val }));
  };

  const handleTestOllama = async () => {
    setOllamaTest("testing");
    try { setOllamaTest(await testOllama(draft.ollama_base_url)); }
    catch { setOllamaTest({ ok: false, error: "Request failed", models: [] }); }
  };

  const handleTestResponses = async () => {
    setRespTest("testing");
    try { setRespTest(await testResponses(draft.responses_base_url, draft.responses_api_key_input)); }
    catch (e) { setRespTest({ ok: false, error: errorMessage(e, "Request failed"), models: [] }); }
  };

  const handleSave = async () => {
    setSaving(true); setFb(null);
    // The API key is write-only: send it only when typed, or "" to remove it.
    const keyUpdate = draft.responses_api_key_clear ? { responses_api_key: "" }
      : draft.responses_api_key_input ? { responses_api_key: draft.responses_api_key_input } : {};
    try {
      const updated = await updateConfig({
        llm_provider: draft.llm_provider,
        responses_base_url: draft.responses_base_url,
        responses_model: draft.responses_model,
        ...keyUpdate,
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
      setFb({ msg: errorMessage(e, "Failed to save"), type: "error" });
    } finally { setSaving(false); }
  };

  const dirty = draft && cfg && JSON.stringify(draft) !== JSON.stringify(cfg);
  const green  = t.status.signed_off[t.mode === "light" ? "light" : "dark"];

  if (loading) return <SectionCard theme={t} title="Analysis configuration"><div style={{ color: t.c.text3 }}>Loading…</div></SectionCard>;

  return (
    <>
      <SectionCard theme={t} title="LLM provider" subtitle="takes effect on next job">
        <div style={{ maxWidth: 540 }}>
          <Field theme={t} label="Provider">
            <SelectInput theme={t} value={draft?.llm_provider || "ollama"} onChange={set("llm_provider")}
              options={[
                { value: "ollama", label: "Ollama (local — code stays on your infrastructure)" },
                { value: "responses", label: "Responses API (/v1/responses, API key)" },
              ]} />
          </Field>
          {draft?.llm_provider === "responses" && (
            <div style={{ padding: "10px 12px", borderRadius: t.radius, fontSize: 12, lineHeight: 1.5,
              background: `${t.sev.medium.fg}14`, border: `1px solid ${t.sev.medium.fg}33`, color: t.c.text2 }}>
              Source code under review will be <b>sent to this provider</b>. Requests ask it not to
              store them (<code>store: false</code>), but its own retention policy applies.
            </div>
          )}
        </div>
      </SectionCard>

      {draft?.llm_provider === "responses" && (
        <SectionCard theme={t} title="Responses API" subtitle="OpenAI or any compatible server">
          <div style={{ maxWidth: 540 }}>
            <Field theme={t} label="Base URL" hint="requests go to {base}/responses">
              <div style={{ display: "flex", gap: 8 }}>
                <TextInput theme={t} value={draft?.responses_base_url || ""}
                  onChange={e => { set("responses_base_url")(e); setRespTest(null); }}
                  mono placeholder="https://api.openai.com/v1" />
                <Btn theme={t} size="md"
                  variant={respTest && respTest !== "testing" ? (respTest.ok ? "success" : "danger") : "ghost"}
                  onClick={handleTestResponses} disabled={respTest === "testing" || !draft?.responses_base_url}>
                  {respTest === "testing" ? "Testing…" : "Test"}
                </Btn>
              </div>
              {respTest && respTest !== "testing" && (
                <div style={{ marginTop: 9, padding: "10px 12px", borderRadius: t.radius,
                  background: `${respTest.ok ? green : t.sev.critical.fg}14`,
                  border: `1px solid ${respTest.ok ? green : t.sev.critical.fg}33`, fontSize: 12 }}>
                  {respTest.ok ? (
                    <>
                      <span style={{ color: green, fontWeight: 600 }}>✓ Connected</span>
                      {respTest.note && <span style={{ marginLeft: 8, color: t.c.text3 }}>{respTest.note}</span>}
                      {respTest.models?.length > 0 && (
                        <div style={{ marginTop: 7, display: "flex", gap: 6, flexWrap: "wrap",
                          maxHeight: 132, overflowY: "auto" }}>
                          {respTest.models.map(m => (
                            <span key={m} onClick={() => setDraft(d => ({ ...d, responses_model: m }))}
                              style={{ cursor: "pointer", padding: "2px 9px", borderRadius: 999,
                                fontFamily: t.fontMono, fontSize: 11.5, transition: "all 0.12s",
                                background: draft?.responses_model === m ? t.c.accentBg : t.c.raised2,
                                border: `1px solid ${draft?.responses_model === m ? t.c.accent : t.c.border}`,
                                color: draft?.responses_model === m ? t.c.accent : t.c.text2 }}>{m}</span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <span style={{ color: t.sev.critical.fg }}>✗ {respTest.error}</span>
                  )}
                </div>
              )}
            </Field>
            <Field theme={t} label="Model">
              <TextInput theme={t} value={draft?.responses_model || ""} onChange={set("responses_model")}
                mono placeholder="e.g. gpt-5.1-codex" />
            </Field>
            <Field theme={t} label="API key" hint="stored encrypted; never shown again">
              <TextInput theme={t} type="password" value={draft?.responses_api_key_input || ""}
                onChange={e => { setDraft(d => ({ ...d, responses_api_key_input: e.target.value,
                  responses_api_key_clear: false })); setRespTest(null); }}
                mono placeholder={cfg?.responses_api_key_set && !draft?.responses_api_key_clear
                  ? `Saved key ••••${cfg.responses_api_key_last4 || ""} — leave blank to keep`
                  : "sk-…"} />
              {cfg?.responses_api_key_set && (
                <div style={{ marginTop: 6, fontSize: 11.5, color: t.c.text3 }}>
                  {draft?.responses_api_key_clear ? (
                    <>Saved key will be removed on save. <a href="#" onClick={e => { e.preventDefault();
                      setDraft(d => ({ ...d, responses_api_key_clear: false })); }}>Undo</a></>
                  ) : (
                    <a href="#" onClick={e => { e.preventDefault();
                      setDraft(d => ({ ...d, responses_api_key_clear: true, responses_api_key_input: "" })); }}>
                      Remove saved key</a>
                  )}
                </div>
              )}
            </Field>
          </div>
        </SectionCard>
      )}

      {draft?.llm_provider !== "responses" && (
      <SectionCard theme={t} title="Ollama" subtitle="takes effect on next job">
        <div style={{ maxWidth: 540 }}>
          <Field theme={t} label="Base URL">
            <div style={{ display: "flex", gap: 8 }}>
              <TextInput theme={t} value={draft?.ollama_base_url || ""}
                onChange={e => { set("ollama_base_url")(e); setOllamaTest(null); }}
                mono placeholder="http://localhost:11434" />
              <Btn theme={t} size="md"
                variant={ollamaTest && ollamaTest !== "testing" ? (ollamaTest.ok ? "success" : "danger") : "ghost"}
                onClick={handleTestOllama} disabled={ollamaTest === "testing" || !draft?.ollama_base_url}>
                {ollamaTest === "testing" ? "Testing…" : "Test"}
              </Btn>
            </div>
            {ollamaTest && ollamaTest !== "testing" && (
              <div style={{ marginTop: 9, padding: "10px 12px", borderRadius: t.radius,
                background: `${ollamaTest.ok ? green : t.sev.critical.fg}14`,
                border: `1px solid ${ollamaTest.ok ? green : t.sev.critical.fg}33`, fontSize: 12 }}>
                {ollamaTest.ok ? (
                  <>
                    <span style={{ color: green, fontWeight: 600 }}>✓ Connected</span>
                    {ollamaTest.models?.length > 0 && (
                      <div style={{ marginTop: 7, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {ollamaTest.models.map(m => (
                          <span key={m} onClick={() => setDraft(d => ({ ...d, ollama_model: m }))}
                            style={{ cursor: "pointer", padding: "2px 9px", borderRadius: 999,
                              fontFamily: t.fontMono, fontSize: 11.5, transition: "all 0.12s",
                              background: draft?.ollama_model === m ? t.c.accentBg : t.c.raised2,
                              border: `1px solid ${draft?.ollama_model === m ? t.c.accent : t.c.border}`,
                              color: draft?.ollama_model === m ? t.c.accent : t.c.text2 }}>{m}</span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <span style={{ color: t.sev.critical.fg }}>✗ {ollamaTest.error}</span>
                )}
              </div>
            )}
          </Field>
          <Field theme={t} label="Model">
            <TextInput theme={t} value={draft?.ollama_model || ""} onChange={set("ollama_model")}
              mono placeholder="e.g. qwen3:4b, llama3:8b" />
          </Field>
          <Field theme={t} label="Chain-of-thought" hint="enable for models that support <think> blocks">
            <Toggle theme={t} value={!!draft?.ollama_think}
              onChange={v => setDraft(d => ({ ...d, ollama_think: v }))}
              label={draft?.ollama_think ? "Enabled" : "Disabled"} />
          </Field>
          <Field theme={t} label="Context window (num_ctx)" hint="0 = use model default">
            <TextInput theme={t} type="number" value={draft?.ollama_num_ctx ?? 0}
              onChange={set("ollama_num_ctx")} mono min="0" step="1024" />
            <div style={{ fontSize: 11.5, color: t.c.text3, marginTop: 5 }}>
              {draft?.ollama_num_ctx > 0
                ? `${Number(draft.ollama_num_ctx).toLocaleString()} tokens — override active`
                : "Using model default"}
            </div>
          </Field>
        </div>
      </SectionCard>
      )}

      <SectionCard theme={t} title="LLM context" subtitle="takes effect on next job">
        <div style={{ maxWidth: 540 }}>
          <Field theme={t} label="Max content chars" hint="1 token ≈ 4 chars">
            <TextInput theme={t} type="number" value={draft?.llm_max_content_chars || ""}
              onChange={set("llm_max_content_chars")} mono />
            <div style={{ fontSize: 11.5, color: t.c.text3, marginTop: 5 }}>
              ~{Math.round((draft?.llm_max_content_chars || 0) / 4).toLocaleString()} tokens per call
            </div>
          </Field>
        </div>
      </SectionCard>

      <SectionCard theme={t} title="Scanning" subtitle="takes effect on next job">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 540 }}>
          <Field theme={t} label="Max file size (KB)">
            <TextInput theme={t} type="number" value={draft?.max_file_size_kb || ""} onChange={set("max_file_size_kb")} mono />
          </Field>
          <Field theme={t} label="Max files per repo">
            <TextInput theme={t} type="number" value={draft?.max_files_per_repo || ""} onChange={set("max_files_per_repo")} mono />
          </Field>
        </div>
      </SectionCard>

      <SectionCard theme={t} title="Session & worker" subtitle="worker fields require restart">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 540 }}>
          <Field theme={t} label="Token expiry (min)">
            <TextInput theme={t} type="number" value={draft?.access_token_expire_minutes || ""} onChange={set("access_token_expire_minutes")} mono />
          </Field>
          <Field theme={t} label="Max concurrent jobs">
            <TextInput theme={t} type="number" value={draft?.worker_max_jobs || ""} onChange={set("worker_max_jobs")} mono />
          </Field>
        </div>
      </SectionCard>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Btn theme={t} variant={dirty ? "primary" : "ghost"} onClick={() => dirty && handleSave()}
          disabled={saving || !dirty}>
          {saving ? "Saving…" : dirty ? "Save all changes" : "No changes"}
        </Btn>
        {dirty && <span style={{ fontSize: 12, color: t.c.accent }}>Unsaved changes</span>}
      </div>
      <Feedback theme={t} {...(fb || {})} />
    </>
  );
}

export default function Settings() {
  const { user }  = useAuth();
  const { theme } = useTheme();
  const isAdmin   = user?.role === "admin";
  const t         = theme;

  const tabs = [
    { key: "account", label: "Account" },
    ...(isAdmin ? [
      { key: "users",  label: "Users" },
      { key: "config", label: "Analysis" },
    ] : []),
  ];
  const [tab, setTab] = useState("account");

  return (
    <PageWrap theme={t} max={840}>
      <PageHeader theme={t} title="Settings"
        subtitle={isAdmin ? "Account, users, and analysis engine" : "Manage your account"} />
      <Tabs theme={t} tabs={tabs} active={tab} onChange={setTab} />
      {tab === "account" && <AccountTab  theme={t} username={user?.username} />}
      {tab === "users"   && isAdmin && <UsersTab    theme={t} currentUser={user?.username} />}
      {tab === "config"  && isAdmin && <AnalysisTab theme={t} />}
    </PageWrap>
  );
}
