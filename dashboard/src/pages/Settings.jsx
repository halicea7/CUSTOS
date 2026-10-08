import React, { useEffect, useState } from "react";
import { useAuth, useTheme, useUnsavedGuard } from "../App.jsx";
import {
  getUsers, createUser, updateUserRole, deleteUser,
  changePassword, getConfig, updateConfig, testOllama, testResponses, testS1,
} from "../api/settings.js";
import { Btn, Avatar, RoleBadge } from "../components/atoms.jsx";
import {
  ChoiceCards, Feedback, Field, PageHeader, PageWrap, SectionCard, SelectInput, Slider, Tabs, TextInput, Toggle,
} from "../components/ui.jsx";
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

const NUM_CTX_STEPS = [0, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
const CONTENT_CHAR_STEPS = [16000, 32000, 48000, 64000, 96000, 128000, 192000, 256000, 384000, 512000, 768000, 1000000];
// System prompt, instructions and SAST context sent alongside the code (approx.).
const PROMPT_OVERHEAD_TOKENS = 2500;

const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1024)}K` : String(n));
const fmtNumCtx = (v) => (v ? `${fmtK(v)} tokens` : "Model default");
const fmtChars = (v) => `${Math.round(v / 1000)}K chars`;

// Same format as the API's url_origin(): scheme://host:port, default port explicit.
function urlOrigin(url) {
  try {
    const u = new URL(url);
    const scheme = u.protocol.replace(":", "");
    return `${scheme}://${u.hostname}:${u.port || { https: "443", http: "80" }[scheme] || ""}`;
  } catch {
    return null;
  }
}

// https://api.openai.com:443 → https://api.openai.com
const prettyOrigin = (o) => (o || "").replace(/^(https:\/\/.+):443$/, "$1").replace(/^(http:\/\/.+):80$/, "$1");

const URL_RE = /^https?:\/\/\S+$/;
const S1_CONSOLE_RE = /^https:\/\/[^\s/]+\/?$/;
const S1_SCANNER_OPTIONS = [
  { value: "secret", label: "Secrets" },
  { value: "iac", label: "IaC misconfigurations" },
  { value: "vuln", label: "Vulnerable dependencies" },
];
const intIn = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi; };

function validate(d, cfg) {
  if (!d) return {};
  const e = {};
  if (!URL_RE.test(d.ollama_base_url || "")) e.ollama_base_url = "Enter an http:// or https:// URL";
  if (!URL_RE.test(d.responses_base_url || "")) e.responses_base_url = "Enter an http:// or https:// URL";
  if (d.llm_provider === "ollama" && !d.ollama_model?.trim()) e.ollama_model = "Enter a model name";
  if (d.llm_provider === "responses") {
    if (!d.responses_model?.trim()) e.responses_model = "Pick a model from the connection test, or type its name";
    const bound = cfg?.responses_api_key_origin;
    if (bound && !d.responses_api_key_input && !d.responses_api_key_clear
        && urlOrigin(d.responses_base_url) !== bound) {
      e.responses_api_key = `The saved key only works with ${prettyOrigin(bound)}. Enter the key again to use this host, or remove it.`;
    }
  }
  if (d.s1_enabled) {
    if (!S1_CONSOLE_RE.test(d.s1_console_url || "")) e.s1_console_url = "Enter the console's https:// address, e.g. https://<region>.sentinelone.net";
    if (!/^\d{1,30}$/.test(d.s1_scope_id || "")) e.s1_scope_id = "The numeric account or site ID";
    if (!d.s1_scanners?.length) e.s1_scanners = "Pick at least one scanner";
    const bound = cfg?.s1_token_origin;
    const sameConsole = bound && urlOrigin(d.s1_console_url) === bound;
    if (!d.s1_api_token_input && (d.s1_api_token_clear || !sameConsole)) {
      e.s1_api_token = bound && !d.s1_api_token_clear
        ? `The saved token only works with ${prettyOrigin(bound)}. Enter the token for this console.`
        : "Enter the service user API token";
    }
  }
  if (!intIn(d.max_file_size_kb, 1, 10240)) e.max_file_size_kb = "1 – 10,240 KB";
  if (!intIn(d.max_files_per_repo, 1, 10000)) e.max_files_per_repo = "1 – 10,000 files";
  if (!intIn(d.access_token_expire_minutes, 5, 10080)) e.access_token_expire_minutes = "5 – 10,080 minutes";
  if (!intIn(d.worker_max_jobs, 1, 64)) e.worker_max_jobs = "1 – 64 jobs";
  if (!intIn(d.worker_job_timeout, 60, 86400)) e.worker_job_timeout = "60 – 86,400 seconds";
  return e;
}

// Put a server-side validation message next to the field it is about.
function fieldForServerError(msg) {
  if (/saved API key is bound|Re-enter the key/i.test(msg)) return "responses_api_key";
  if (/model for the Responses API/i.test(msg)) return "responses_model";
  if (/plain HTTP/i.test(msg)) return "responses_base_url";
  if (/SentinelOne token is bound/i.test(msg)) return "s1_api_token";
  return null;
}

// Live health of the *saved* provider config, shown in the card header.
function useProviderStatus(cfg) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!cfg) return undefined;
    let live = true;
    const done = (s) => live && setStatus(s);
    setStatus({ tone: "pending", text: "Checking…" });
    const check = (res, model) => {
      if (!res.ok) return { tone: "error", text: res.error || "Unreachable" };
      if (res.models?.length && model && !res.models.includes(model)) {
        return { tone: "warn", text: `Connected · model “${model}” not found` };
      }
      return { tone: "ok", text: res.models?.length ? `Connected · ${res.models.length} models` : "Connected" };
    };
    if (cfg.llm_provider === "responses") {
      if (!cfg.responses_api_key_set) {
        done({ tone: "warn", text: "No API key saved" });
      } else {
        testResponses(cfg.responses_base_url)
          .then((r) => done(check(r, cfg.responses_model)))
          .catch(() => done({ tone: "error", text: "Check failed" }));
      }
    } else {
      testOllama(cfg.ollama_base_url)
        .then((r) => done(check(r, cfg.ollama_model)))
        .catch(() => done({ tone: "error", text: "Check failed" }));
    }
    return () => { live = false; };
  }, [cfg]);
  return status;
}

function useS1Status(cfg) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!cfg) return undefined;
    if (!cfg.s1_enabled) { setStatus({ tone: "pending", text: "Off" }); return undefined; }
    let live = true;
    setStatus({ tone: "pending", text: "Checking…" });
    testS1({ console_url: cfg.s1_console_url, scope_type: cfg.s1_scope_type, scope_id: cfg.s1_scope_id })
      .then((r) => live && setStatus(r.ok ? { tone: "ok", text: "Connected" } : { tone: "error", text: r.error }))
      .catch(() => live && setStatus({ tone: "error", text: "Check failed" }));
    return () => { live = false; };
  }, [cfg]);
  return status;
}

function StatusPill({ theme, status }) {
  if (!status) return null;
  const t = theme;
  const green = t.status.signed_off[t.mode === "light" ? "light" : "dark"];
  const color = { ok: green, warn: t.sev.medium.fg, error: t.sev.critical.fg, pending: t.c.text3 }[status.tone];
  return (
    <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12,
      color, maxWidth: 360, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0 }} />
      {status.text}
    </span>
  );
}

function ConnectionResult({ theme, result, selected, onPick }) {
  if (!result || result === "testing") return null;
  const t = theme;
  const green = t.status.signed_off[t.mode === "light" ? "light" : "dark"];
  const color = result.ok ? green : result.needs_key ? t.sev.medium.fg : t.sev.critical.fg;
  return (
    <div role="status" style={{ marginTop: 9, padding: "10px 12px", borderRadius: t.radius, fontSize: 12,
      background: `${color}14`, border: `1px solid ${color}33` }}>
      {result.ok ? (
        <>
          <span style={{ color: green, fontWeight: 600 }}>✓ Connected</span>
          {result.note && <span style={{ marginLeft: 8, color: t.c.text3 }}>{result.note}</span>}
          {result.models?.length > 0 && (
            <>
              <div style={{ marginTop: 6, color: t.c.text3 }}>Click a model to use it:</div>
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 132, overflowY: "auto" }}>
                {result.models.map((m) => (
                  <button type="button" key={m} onClick={() => onPick(m)} aria-pressed={selected === m}
                    style={{ cursor: "pointer", padding: "2px 9px", borderRadius: 999,
                      fontFamily: t.fontMono, fontSize: 11.5, transition: "all 0.12s",
                      background: selected === m ? t.c.accentBg : t.c.raised2,
                      border: `1px solid ${selected === m ? t.c.accent : t.c.border}`,
                      color: selected === m ? t.c.accent : t.c.text2 }}>{m}</button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <span style={{ color }}>{result.needs_key ? "🔑" : "✗"} {result.error}</span>
      )}
    </div>
  );
}

function AnalysisTab({ theme }) {
  const [cfg,     setCfg]     = useState(null);
  const [draft,   setDraft]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [fb,      setFb]      = useState(null);       // { msg, type } for the save bar
  const [serverErr, setServerErr] = useState({});    // { field: msg } from the last save
  const [ollamaTest, setOllamaTest] = useState(null);
  const [respTest, setRespTest] = useState(null);
  const [s1Test, setS1Test] = useState(null);
  const { setDirty } = useUnsavedGuard();
  const status = useProviderStatus(cfg);
  const s1Status = useS1Status(cfg);
  const t = theme;

  useEffect(() => {
    getConfig().then(c => { setCfg(c); setDraft(c); })
      .catch(() => setFb({ msg: "Failed to load configuration", type: "error" }))
      .finally(() => setLoading(false));
  }, []);

  const dirty = !!(draft && cfg && JSON.stringify(draft) !== JSON.stringify(cfg));
  useEffect(() => { setDirty(dirty); }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  // A transient "Saved" message clears itself.
  useEffect(() => {
    if (fb?.type !== "success") return undefined;
    const id = setTimeout(() => setFb(null), 3000);
    return () => clearTimeout(id);
  }, [fb]);

  const errors = { ...validate(draft, cfg), ...serverErr };
  const errorCount = Object.keys(validate(draft, cfg)).length;

  const update = (patch) => {
    setDraft(d => ({ ...d, ...patch }));
    setServerErr(e => { const next = { ...e }; Object.keys(patch).forEach(k => delete next[k]); return next; });
    if (fb?.type === "error") setFb(null);
  };
  const set = (key) => (e) => update({ [key]: e && e.target ? e.target.value : e });

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

  const handleTestS1 = async () => {
    setS1Test("testing");
    try {
      const r = await testS1({ console_url: draft.s1_console_url, scope_type: draft.s1_scope_type,
        scope_id: draft.s1_scope_id, api_token: draft.s1_api_token_input || null });
      setS1Test(r.ok ? { ...r, note: r.cli_version ? `Latest CLI on this console: ${r.cli_version}` : null } : r);
    } catch (e) { setS1Test({ ok: false, error: errorMessage(e, "Request failed") }); }
  };

  const toggleScanner = (v) => update({ s1_scanners: draft.s1_scanners.includes(v)
    ? draft.s1_scanners.filter(x => x !== v)
    : S1_SCANNER_OPTIONS.map(o => o.value).filter(x => x === v || draft.s1_scanners.includes(x)) });

  const handleDiscard = () => {
    setDraft(cfg); setServerErr({}); setFb(null); setOllamaTest(null); setRespTest(null); setS1Test(null);
  };

  const handleSave = async () => {
    setSaving(true); setFb(null); setServerErr({});
    // The API key is write-only: send it only when typed, or "" to remove it.
    const keyUpdate = draft.responses_api_key_clear ? { responses_api_key: "" }
      : draft.responses_api_key_input ? { responses_api_key: draft.responses_api_key_input } : {};
    const s1TokenUpdate = draft.s1_api_token_clear ? { s1_api_token: "" }
      : draft.s1_api_token_input ? { s1_api_token: draft.s1_api_token_input } : {};
    try {
      const updated = await updateConfig({
        llm_provider: draft.llm_provider,
        responses_base_url: draft.responses_base_url,
        responses_model: draft.responses_model,
        ...keyUpdate,
        ...s1TokenUpdate,
        s1_enabled: draft.s1_enabled,
        ...(draft.s1_console_url ? { s1_console_url: draft.s1_console_url } : {}),
        s1_scope_type: draft.s1_scope_type,
        ...(draft.s1_scope_id ? { s1_scope_id: draft.s1_scope_id } : {}),
        ...(draft.s1_scanners?.length ? { s1_scanners: draft.s1_scanners } : {}),
        s1_verify_secrets: draft.s1_verify_secrets,
        s1_publish: draft.s1_publish,
        ollama_base_url: draft.ollama_base_url,
        ollama_model: draft.ollama_model,
        ollama_think: draft.ollama_think,
        ollama_num_ctx: Number(draft.ollama_num_ctx) || 0,
        llm_max_content_chars: Number(draft.llm_max_content_chars),
        max_file_size_kb: Number(draft.max_file_size_kb),
        max_files_per_repo: Number(draft.max_files_per_repo),
        access_token_expire_minutes: Number(draft.access_token_expire_minutes),
        worker_max_jobs: Number(draft.worker_max_jobs),
        worker_job_timeout: Number(draft.worker_job_timeout),
      });
      setCfg(updated); setDraft(updated); setRespTest(null); setS1Test(null);
      setFb({ msg: "Saved", type: "success" });
    } catch (e) {
      const msg = errorMessage(e, "Failed to save");
      const field = fieldForServerError(msg);
      if (field) setServerErr({ [field]: msg });
      else setFb({ msg, type: "error" });
    } finally { setSaving(false); }
  };

  if (loading) return <SectionCard theme={t} title="Analysis configuration"><div style={{ color: t.c.text3 }}>Loading…</div></SectionCard>;
  if (!draft) return <Feedback theme={t} {...(fb || {})} />;

  const isResponses = draft.llm_provider === "responses";
  const boundOrigin = cfg?.responses_api_key_origin;
  const promptTokens = Math.round((Number(draft.llm_max_content_chars) || 0) / 4) + PROMPT_OVERHEAD_TOKENS;
  const numCtx = Number(draft.ollama_num_ctx) || 0;
  const overflowsCtx = !isResponses && numCtx > 0 && promptTokens > numCtx;
  const hint = { fontSize: 11.5, color: t.c.text3, marginTop: 6, lineHeight: 1.5 };

  return (
    <>
      <p style={{ fontSize: 12.5, color: t.c.text3, margin: "-8px 0 16px" }}>
        Changes apply to the next analysis job. Worker settings apply after the worker restarts.
      </p>

      <SectionCard theme={t} title="AI review" right={<StatusPill theme={t}
        status={draft.llm_provider !== cfg?.llm_provider
          ? { tone: "pending", text: "Save to check this provider" } : status} />}>
        <div style={{ maxWidth: 600 }}>
          <ChoiceCards theme={t} name="llm_provider" value={draft.llm_provider}
            onChange={(v) => update({ llm_provider: v })}
            options={[
              { value: "ollama", label: "Ollama",
                description: "Local model. Code never leaves your infrastructure." },
              { value: "responses", label: "Responses API",
                description: "OpenAI or any /v1/responses-compatible server, with an API key." },
            ]} />

          {isResponses && (
            <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: t.radius, fontSize: 12,
              lineHeight: 1.5, background: `${t.sev.medium.fg}14`, border: `1px solid ${t.sev.medium.fg}33`,
              color: t.c.text2 }}>
              Source code under review will be <b>sent to this provider</b>. Requests ask it not to
              store them (<code style={{ fontFamily: t.fontMono }}>store: false</code>), but its own
              retention policy applies.
            </div>
          )}

          <div style={{ borderTop: `1px solid ${t.c.border}`, margin: "18px 0" }} />

          {isResponses ? (
            <>
              <Field theme={t} label="Base URL" hint="requests go to {base}/responses" error={errors.responses_base_url}>
                <TextInput theme={t} value={draft.responses_base_url || ""} mono
                  onChange={e => { set("responses_base_url")(e); setRespTest(null); }}
                  placeholder="https://api.openai.com/v1" />
              </Field>

              <Field theme={t} label="API key" hint="stored encrypted, never shown again" error={errors.responses_api_key}>
                <TextInput theme={t} type="password" autoComplete="off" mono
                  value={draft.responses_api_key_input || ""}
                  onChange={e => { update({ responses_api_key_input: e.target.value, responses_api_key_clear: false }); setRespTest(null); }}
                  placeholder={boundOrigin && !draft.responses_api_key_clear
                    ? `Saved key ••••${cfg.responses_api_key_last4 || ""} — leave blank to keep`
                    : "sk-…"} />
                {boundOrigin && (
                  <div style={{ ...hint, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    {draft.responses_api_key_clear ? (
                      <>
                        <span style={{ color: t.sev.medium.fg }}>The saved key will be removed when you save.</span>
                        <Btn theme={t} size="sm" variant="quiet"
                          onClick={() => update({ responses_api_key_clear: false })}>Undo</Btn>
                      </>
                    ) : (
                      <>
                        <span>Only ever sent to <code style={{ fontFamily: t.fontMono }}>{prettyOrigin(boundOrigin)}</code>.</span>
                        <Btn theme={t} size="sm" variant="danger"
                          onClick={() => update({ responses_api_key_clear: true, responses_api_key_input: "" })}>
                          Remove saved key
                        </Btn>
                      </>
                    )}
                  </div>
                )}
              </Field>

              <div style={{ marginBottom: 16 }}>
                <Btn theme={t}
                  variant={respTest && respTest !== "testing" ? (respTest.ok ? "success" : "danger") : "ghost"}
                  onClick={handleTestResponses}
                  disabled={respTest === "testing" || !!errors.responses_base_url}>
                  {respTest === "testing" ? "Testing…" : "Test connection"}
                </Btn>
                <ConnectionResult theme={t} result={respTest} selected={draft.responses_model}
                  onPick={(m) => update({ responses_model: m })} />
              </div>

              <Field theme={t} label="Model" error={errors.responses_model}>
                <TextInput theme={t} value={draft.responses_model || ""} onChange={set("responses_model")}
                  mono placeholder="e.g. gpt-5.1-codex" />
              </Field>
            </>
          ) : (
            <>
              <Field theme={t} label="Base URL" error={errors.ollama_base_url}>
                <div style={{ display: "flex", gap: 8 }}>
                  <TextInput theme={t} value={draft.ollama_base_url || ""} mono
                    onChange={e => { set("ollama_base_url")(e); setOllamaTest(null); }}
                    placeholder="http://localhost:11434" />
                  <Btn theme={t}
                    variant={ollamaTest && ollamaTest !== "testing" ? (ollamaTest.ok ? "success" : "danger") : "ghost"}
                    onClick={handleTestOllama} disabled={ollamaTest === "testing" || !!errors.ollama_base_url}>
                    {ollamaTest === "testing" ? "Testing…" : "Test"}
                  </Btn>
                </div>
                <ConnectionResult theme={t} result={ollamaTest} selected={draft.ollama_model}
                  onPick={(m) => update({ ollama_model: m })} />
              </Field>
              <Field theme={t} label="Model" error={errors.ollama_model}>
                <TextInput theme={t} value={draft.ollama_model || ""} onChange={set("ollama_model")}
                  mono placeholder="e.g. qwen3:4b, llama3:8b" />
              </Field>
              <Field theme={t} label="Chain-of-thought" hint="for models that support <think> blocks">
                <Toggle theme={t} value={!!draft.ollama_think}
                  onChange={v => update({ ollama_think: v })}
                  label={draft.ollama_think ? "Enabled" : "Disabled"} />
              </Field>
              <Field theme={t} label="Context window" hint="Ollama num_ctx">
                <Slider theme={t} value={numCtx} steps={NUM_CTX_STEPS} format={fmtNumCtx}
                  onChange={v => update({ ollama_num_ctx: v })} />
                <div style={hint}>
                  {numCtx ? "Overrides the model's default for every request. Larger windows use more GPU memory."
                    : "Uses the window set in the model or its Modelfile."}
                </div>
              </Field>
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard theme={t} title="SentinelOne CNS" subtitle="extra scanning layer"
        right={<StatusPill theme={t} status={draft.s1_enabled !== cfg?.s1_enabled
          ? { tone: "pending", text: "Save to check" } : s1Status} />}>
        <div style={{ maxWidth: 600 }}>
          <Field theme={t} label="Scan with SentinelOne" hint="runs s1-cns-cli on every submission">
            <Toggle theme={t} value={!!draft.s1_enabled} onChange={v => update({ s1_enabled: v })}
              label={draft.s1_enabled ? "Enabled" : "Disabled"} />
          </Field>

          {draft.s1_enabled && (
            <>
              <Field theme={t} label="Management console URL" error={errors.s1_console_url}>
                <TextInput theme={t} value={draft.s1_console_url || ""} mono
                  onChange={e => { set("s1_console_url")(e); setS1Test(null); }}
                  placeholder="https://usea1-xxx.sentinelone.net" />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14 }}>
                <Field theme={t} label="Scope type">
                  <SelectInput theme={t} value={draft.s1_scope_type || "ACCOUNT"}
                    onChange={e => { set("s1_scope_type")(e); setS1Test(null); }}
                    options={[{ value: "ACCOUNT", label: "Account" }, { value: "SITE", label: "Site" }]} />
                </Field>
                <Field theme={t} label="Scope ID" hint="where the service user was created" error={errors.s1_scope_id}>
                  <TextInput theme={t} value={draft.s1_scope_id || ""} mono
                    onChange={e => { set("s1_scope_id")(e); setS1Test(null); }} placeholder="e.g. 123456789012345678" />
                </Field>
              </div>

              <Field theme={t} label="Service user API token" hint="stored encrypted, never shown again"
                error={errors.s1_api_token}>
                <TextInput theme={t} type="password" autoComplete="off" mono
                  value={draft.s1_api_token_input || ""}
                  onChange={e => { update({ s1_api_token_input: e.target.value, s1_api_token_clear: false }); setS1Test(null); }}
                  placeholder={cfg?.s1_token_origin && !draft.s1_api_token_clear
                    ? `Saved token ••••${cfg.s1_token_last4 || ""} — leave blank to keep` : "Paste the token"} />
                {cfg?.s1_token_origin && (
                  <div style={{ ...hint, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    {draft.s1_api_token_clear ? (
                      <>
                        <span style={{ color: t.sev.medium.fg }}>The saved token will be removed when you save.</span>
                        <Btn theme={t} size="sm" variant="quiet" onClick={() => update({ s1_api_token_clear: false })}>Undo</Btn>
                      </>
                    ) : (
                      <>
                        <span>Only ever sent to <code style={{ fontFamily: t.fontMono }}>{prettyOrigin(cfg.s1_token_origin)}</code>.</span>
                        <Btn theme={t} size="sm" variant="danger"
                          onClick={() => update({ s1_api_token_clear: true, s1_api_token_input: "" })}>Remove saved token</Btn>
                      </>
                    )}
                  </div>
                )}
              </Field>

              <div style={{ marginBottom: 16 }}>
                <Btn theme={t}
                  variant={s1Test && s1Test !== "testing" ? (s1Test.ok ? "success" : "danger") : "ghost"}
                  onClick={handleTestS1}
                  disabled={s1Test === "testing" || !!errors.s1_console_url || !!errors.s1_scope_id}>
                  {s1Test === "testing" ? "Testing…" : "Test connection"}
                </Btn>
                <ConnectionResult theme={t} result={s1Test} />
              </div>

              <Field theme={t} label="Scanners" error={errors.s1_scanners}>
                <div role="group" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {S1_SCANNER_OPTIONS.map(o => {
                    const on = draft.s1_scanners?.includes(o.value);
                    return (
                      <label key={o.value} style={{ display: "inline-flex", alignItems: "center", gap: 7,
                        padding: "6px 11px", borderRadius: 999, cursor: "pointer", fontSize: 12.5,
                        border: `1px solid ${on ? t.c.accent : t.c.border}`,
                        background: on ? t.c.accentBg : t.c.bg, color: on ? t.c.accent : t.c.text2 }}>
                        <input type="checkbox" checked={!!on} onChange={() => toggleScanner(o.value)}
                          style={{ accentColor: t.c.accent, margin: 0 }} />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              </Field>

              {draft.s1_scanners?.includes("secret") && (
                <Field theme={t} label="Verify detected secrets">
                  <Toggle theme={t} value={!!draft.s1_verify_secrets}
                    onChange={v => update({ s1_verify_secrets: v })}
                    label={draft.s1_verify_secrets ? "On" : "Off"} />
                  <div style={{ ...hint, color: draft.s1_verify_secrets ? t.sev.medium.fg : t.c.text3 }}>
                    When on, the CLI logs in to the real service (AWS, GitHub, …) with each credential it finds
                    to check whether it is live. Off by default: only enable it if your policy allows that.
                  </div>
                </Field>
              )}

              <Field theme={t} label="Publish results to SentinelOne">
                <Toggle theme={t} value={!!draft.s1_publish} onChange={v => update({ s1_publish: v })}
                  label={draft.s1_publish ? "On" : "Off"} />
                <div style={hint}>
                  Sends IaC and vulnerability findings to your SentinelOne console under the repository&rsquo;s GitHub name.
                  Code is always scanned locally; without this, only scanner configuration is fetched from the console.
                </div>
              </Field>
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard theme={t} title="Prompt size">
        <div style={{ maxWidth: 600 }}>
          <Field theme={t} label="Source code per request">
            <Slider theme={t} value={Number(draft.llm_max_content_chars)} steps={CONTENT_CHAR_STEPS}
              format={fmtChars} onChange={v => update({ llm_max_content_chars: v })} />
            <div style={hint}>
              ≈ {fmtK(promptTokens)} tokens per request including instructions. Larger repos are split
              across several requests.
            </div>
            {overflowsCtx && (
              <div role="alert" style={{ ...hint, color: t.sev.medium.fg }}>
                ⚠ This is larger than the {fmtK(numCtx)}-token context window above, so Ollama will
                cut prompts short. Raise the window or lower this.
              </div>
            )}
          </Field>
        </div>
      </SectionCard>

      <SectionCard theme={t} title="Scanning">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 600 }}>
          <Field theme={t} label="Max file size (KB)" hint="larger files skipped" error={errors.max_file_size_kb}>
            <TextInput theme={t} type="number" value={draft.max_file_size_kb ?? ""} onChange={set("max_file_size_kb")} mono />
          </Field>
          <Field theme={t} label="Max files sent to LLM" hint="most relevant first" error={errors.max_files_per_repo}>
            <TextInput theme={t} type="number" value={draft.max_files_per_repo ?? ""} onChange={set("max_files_per_repo")} mono />
          </Field>
        </div>
      </SectionCard>

      <SectionCard theme={t} title="Session & worker" subtitle="worker settings need a worker restart">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          <Field theme={t} label="Login expiry (min)" error={errors.access_token_expire_minutes}>
            <TextInput theme={t} type="number" value={draft.access_token_expire_minutes ?? ""} onChange={set("access_token_expire_minutes")} mono />
          </Field>
          <Field theme={t} label="Concurrent jobs" error={errors.worker_max_jobs}>
            <TextInput theme={t} type="number" value={draft.worker_max_jobs ?? ""} onChange={set("worker_max_jobs")} mono />
          </Field>
          <Field theme={t} label="Job timeout (sec)" error={errors.worker_job_timeout}>
            <TextInput theme={t} type="number" value={draft.worker_job_timeout ?? ""} onChange={set("worker_job_timeout")} mono />
          </Field>
        </div>
      </SectionCard>

      {(dirty || fb) && <div style={{ height: 72 }} /> /* room so the bar never covers the last field */}
      {(dirty || fb) && (
        // Fixed, not sticky: <main> is an overflow container but the window is
        // what scrolls, so sticky never engages. Offset by the 220px side rail
        // and centred on the 840px page column.
        <div style={{ position: "fixed", left: 220, right: 0, bottom: 16, zIndex: 50,
          display: "flex", justifyContent: "center", padding: "0 34px", pointerEvents: "none" }}>
        <div style={{ width: "100%", maxWidth: 772, pointerEvents: "auto", display: "flex", alignItems: "center",
          gap: 12, padding: "11px 14px 11px 18px", background: t.c.surface,
          border: `1px solid ${t.c.border2}`, borderRadius: t.radiusLg, boxShadow: t.c.shadowHi }}>
          <span role="status" style={{ fontSize: 12.5,
            color: fb?.type === "error" || errorCount ? t.sev.critical.fg
              : fb?.type === "success" ? t.status.signed_off[t.mode === "light" ? "light" : "dark"]
              : t.c.text2 }}>
            {fb?.type === "error" ? fb.msg
              : errorCount ? `Fix ${errorCount} field${errorCount > 1 ? "s" : ""} before saving`
              : fb?.type === "success" && !dirty ? "✓ Saved"
              : "You have unsaved changes"}
          </span>
          {dirty && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Btn theme={t} variant="quiet" onClick={handleDiscard} disabled={saving}>Discard</Btn>
              <Btn theme={t} variant="primary" onClick={handleSave} disabled={saving || errorCount > 0}>
                {saving ? "Saving…" : "Save changes"}
              </Btn>
            </div>
          )}
        </div>
        </div>
      )}
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
  const { guard } = useUnsavedGuard();

  return (
    <PageWrap theme={t} max={840}>
      <PageHeader theme={t} title="Settings"
        subtitle={isAdmin ? "Account, users, and analysis engine" : "Manage your account"} />
      <Tabs theme={t} tabs={tabs} active={tab} onChange={(k) => k !== tab && guard(() => setTab(k))} />
      {tab === "account" && <AccountTab  theme={t} username={user?.username} />}
      {tab === "users"   && isAdmin && <UsersTab    theme={t} currentUser={user?.username} />}
      {tab === "config"  && isAdmin && <AnalysisTab theme={t} />}
    </PageWrap>
  );
}
