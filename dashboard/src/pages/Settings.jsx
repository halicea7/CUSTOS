import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth, useTheme, useUnsavedGuard } from "../App.jsx";
import {
  getUsers, createUser, updateUserRole, deleteUser,
  changePassword, getConfig, updateConfig, testOllama, testResponses, testS1,
} from "../api/settings.js";
import { listRepos } from "../api/repos.js";
import { listMembers } from "../api/groups.js";
import { useGroups } from "../api/queries.js";
import { Btn } from "../components/atoms.jsx";
import { ArmedButton } from "../components/queue/Board.jsx";
import { useToast } from "../components/Toast.jsx";
import {
  ChoiceCards, Feedback, Field, Modal, ModelPicker, PageHeader, ThinkBadge, PageWrap, SectionCard, SelectInput, Slider, Tabs, TextInput, Toggle,
} from "../components/ui.jsx";
import { errorMessage } from "../api/errors.js";

// ── Account ───────────────────────────────────────────────────────────────────

const STRENGTH = [["At least 8 characters", "var(--crit)"], ["Weak", "var(--crit)"], ["Fair", "var(--high)"],
  ["Good", "var(--med)"], ["Strong", "var(--ok)"]];
const strength = (v) => (v.length < 8 ? 0
  : Math.min(4, 1 + (v.length >= 12) + (/[A-Z]/.test(v) && /[a-z]/.test(v)) + (/[^A-Za-z0-9]/.test(v) || /\d/.test(v))));

function AccountTab({ user, onLogout }) {
  const toast = useToast();
  const [form,    setForm]    = useState({ current_password: "", new_password: "", confirm: "" });
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState("");
  const score = strength(form.new_password);
  const mismatch = form.confirm && form.confirm !== form.new_password;

  const handle = async (e) => {
    e?.preventDefault();
    if (form.new_password !== form.confirm) return setErr("New passwords do not match");
    if (form.new_password.length < 8) return setErr("Password must be at least 8 characters");
    setLoading(true); setErr("");
    try {
      await changePassword({ current_password: form.current_password, new_password: form.new_password });
      toast("Password updated");
      setForm({ current_password: "", new_password: "", confirm: "" });
    } catch (e) {
      setErr(errorMessage(e, "Failed to change password"));
    } finally { setLoading(false); }
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="sgrid">
      <section className="panel">
        <div className="panel-h"><h2>Change password</h2></div>
        <form className="panel-b" onSubmit={handle} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input type="text" autoComplete="username" value={user?.username || ""} readOnly hidden />
          <div className="field">
            <label htmlFor="pw-cur">Current password</label>
            <input id="pw-cur" className="input" type="password" autoComplete="current-password"
              value={form.current_password} onChange={set("current_password")} />
          </div>
          <div className="field">
            <label htmlFor="pw-new">New password</label>
            <input id="pw-new" className="input" type="password" autoComplete="new-password"
              value={form.new_password} onChange={set("new_password")} />
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${form.new_password ? Math.max(score, 0.4) * 25 : 0}%`, background: STRENGTH[score][1] }} />
            </div>
            <div className="hint" aria-live="polite">{form.new_password ? STRENGTH[score][0] : STRENGTH[0][0]}</div>
          </div>
          <div className="field">
            <label htmlFor="pw-confirm">Confirm new password</label>
            <input id="pw-confirm" className="input" type="password" autoComplete="new-password"
              value={form.confirm} onChange={set("confirm")} />
            {mismatch && <div className="hint" style={{ color: "var(--crit)" }}>Doesn&rsquo;t match the new password</div>}
          </div>
          {err && <div className="result bad">{err}</div>}
          <div>
            <button type="submit" className="btn primary"
              disabled={loading || !form.current_password || !form.new_password || !form.confirm}>
              {loading ? <><span className="spin" /> Saving</> : "Update password"}
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <div className="panel-h"><h2>This session</h2></div>
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div className="avatar">{(user?.username || "?")[0].toUpperCase()}</div>
            <div className="dim">Signed in as <b style={{ color: "var(--text)" }}>{user?.username}</b> ({user?.role})</div>
          </div>
          <div><button className="btn danger" onClick={onLogout}>Sign out</button></div>
        </div>
      </section>
    </div>
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────

function UsersTab({ currentUser }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: users = [], isPending, error } = useQuery({ queryKey: ["users"], queryFn: getUsers });
  const { data: groups = [] } = useGroups();
  // username → the groups they're in, for the Groups column.
  const { data: groupsOf = new Map() } = useQuery({
    queryKey: ["groups", "all-members", groups.map((g) => g.id).join(",")],
    enabled: groups.length > 0,
    queryFn: async () => {
      const map = new Map();
      await Promise.all(groups.map(async (g) => {
        const members = await listMembers(g.id).catch(() => []);
        members.forEach((m) => map.set(m.username, [...(map.get(m.username) || []), g.name]));
      }));
      return map;
    },
  });
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "analyst" });
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [savingRole, setSavingRole] = useState(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const setRole = async (u, role) => {
    if (role === u.role) return;
    setSavingRole(u.id);
    try {
      const updated = await updateUserRole(u.id, role);
      toast(`${u.username} is now ${updated.role === "admin" ? "an admin" : "an analyst"}`);
      refresh();
    } catch (e) {
      toast(errorMessage(e, "Failed to update role"), { bad: true });
    } finally { setSavingRole(null); }
  };

  const handleCreate = async (e) => {
    e?.preventDefault(); setCreateErr("");
    setCreating(true);
    try {
      const u = await createUser(newUser);
      setNewUser({ username: "", password: "", role: "analyst" });
      toast(`Created ${u.username}`);
      refresh();
    } catch (e) {
      setCreateErr(errorMessage(e, "Failed to create user"));
    } finally { setCreating(false); }
  };

  const handleDelete = async (u) => {
    try {
      await deleteUser(u.id);
      toast(`Deleted ${u.username}`);
      refresh();
      qc.invalidateQueries({ queryKey: ["groups"] });
    } catch (e) {
      toast(errorMessage(e, "Failed to delete user"), { bad: true });
    }
  };

  return (
    <div className="sgrid">
      <section className="panel">
        <div className="panel-h"><h2>User accounts</h2><span className="aside">{users.length} user{users.length !== 1 ? "s" : ""}</span></div>
        {error ? <div className="panel-b"><div className="result bad">{errorMessage(error, "Couldn't load users")}</div></div>
          : isPending ? <div className="empty">Loading…</div> : (
            <table className="tbl">
              <thead><tr><th>User</th><th>Role</th><th className="hide-sm">Groups</th><th className="hide-sm">Created</th><th /></tr></thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.username === currentUser;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div className="avatar" style={{ width: 26, height: 26, fontSize: ".7rem" }}>{u.username[0].toUpperCase()}</div>
                          <span className="mono" style={{ color: "var(--text)" }}>{u.username}</span>
                          {isSelf && <span className="tag">you</span>}
                        </div>
                      </td>
                      <td>
                        <div className="seg" title={isSelf ? "You can't change your own role" : undefined}>
                          {["analyst", "admin"].map((r) => (
                            <button key={r} className={u.role === r ? "on" : ""} disabled={isSelf || savingRole === u.id}
                              onClick={() => setRole(u, r)}>{r === "admin" ? "Admin" : "Analyst"}</button>
                          ))}
                        </div>
                      </td>
                      <td className="hide-sm">
                        {(groupsOf.get(u.username) || []).map((g) => <span key={g} className="gtag" style={{ marginRight: 4 }}>{g}</span>)}
                        {!(groupsOf.get(u.username) || []).length && <span className="muted">—</span>}
                      </td>
                      <td className="hide-sm" style={{ whiteSpace: "nowrap" }}>
                        {new Date(u.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {!isSelf && <ArmedButton onConfirm={() => handleDelete(u)} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </section>

      <section className="panel">
        <div className="panel-h"><h2>Create user</h2></div>
        <form className="panel-b" onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="row-form">
            <div className="field" style={{ flex: "1 1 180px" }}>
              <label htmlFor="nu-name">Username</label>
              <input id="nu-name" className="input mono" autoComplete="off" value={newUser.username}
                onChange={(e) => setNewUser((f) => ({ ...f, username: e.target.value }))} />
            </div>
            <div className="field" style={{ flex: "0 1 160px" }}>
              <label htmlFor="nu-role">Role</label>
              <select id="nu-role" className="input" value={newUser.role}
                onChange={(e) => setNewUser((f) => ({ ...f, role: e.target.value }))}>
                <option value="analyst">Analyst</option><option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="nu-pw">Password</label>
            <input id="nu-pw" className="input" type="password" autoComplete="new-password" placeholder="min 8 characters"
              value={newUser.password} onChange={(e) => setNewUser((f) => ({ ...f, password: e.target.value }))} />
          </div>
          {createErr && <div className="result bad">{createErr}</div>}
          <div>
            <button type="submit" className="btn primary" disabled={creating || !newUser.username.trim() || newUser.password.length < 8}>
              {creating ? <><span className="spin" /> Creating</> : "Create user"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ── Analysis config ───────────────────────────────────────────────────────────

const NUM_CTX_STEPS = [0, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
const MAX_OUTPUT_STEPS = [0, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const fmtMaxOutput = (v) => (v ? `${fmtK(v)} tokens` : "Server default");
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

// Mirrors the API's is_local_url(): loopback, private and link-local IPs,
// single-label names (compose services) and internal-only suffixes.
function isLocalUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return false; }
  if (host === "localhost" || host === "host.docker.internal" || !host.includes(".")) return true;
  if (/\.(local|internal|lan|home\.arpa)$/.test(host)) return true;
  const ip = host.split(".").map(Number);
  if (ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return ip[0] === 10 || ip[0] === 127 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31)
      || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 169 && ip[1] === 254);
  }
  return host === "::1";
}

// Plain http:// to a non-local host: the API key and code would cross the
// network unencrypted. Allowed only by an explicit per-host admin exception.
function needsHttpException(d, cfg) {
  if (d?.llm_provider !== "responses") return false;
  if (!/^http:\/\//i.test(d.responses_base_url || "") || isLocalUrl(d.responses_base_url)) return false;
  return !!(d.responses_api_key_input || (cfg?.responses_api_key_set && !d.responses_api_key_clear));
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
    if (needsHttpException(d, cfg) && d.responses_http_allowed_origin !== urlOrigin(d.responses_base_url)) {
      e.responses_base_url = "Plain HTTP to a non-local host sends the API key and source code unencrypted. "
        + "Use https://, or explicitly allow plain HTTP for this host.";
    }
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
    if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_-]{0,99})?$/.test(d.s1_policy_id || "")) e.s1_policy_id = "Letters, digits, - and _ only (not starting with -)";
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
  if (!intIn(d.repo_check_interval_hours, 0, 720)) e.repo_check_interval_hours = "0 – 720 hours";
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
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!cfg) return undefined;
    let live = true;
    const done = (s, r = null) => { if (live) { setStatus(s); setResult(r); } };
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
          .then((r) => done(check(r, cfg.responses_model), r))
          .catch(() => done({ tone: "error", text: "Check failed" }));
      }
    } else {
      testOllama(cfg.ollama_base_url)
        .then((r) => done(check(r, cfg.ollama_model), r))
        .catch(() => done({ tone: "error", text: "Check failed" }));
    }
    return () => { live = false; };
  }, [cfg]);
  return [status, result];
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

function ConnectionResult({ theme, result }) {
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
            <span style={{ marginLeft: 8, color: t.c.text3 }}>
              · {result.models.length} model{result.models.length === 1 ? "" : "s"} — pick one in the Model list
            </span>
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
  const [confirmHttp, setConfirmHttp] = useState(false);
  const [repos, setRepos] = useState([]);
  const { setDirty } = useUnsavedGuard();
  const [status, statusResult] = useProviderStatus(cfg);
  const s1Status = useS1Status(cfg);
  const t = theme;

  useEffect(() => {
    listRepos().then(setRepos).catch(() => setRepos([]));
  }, []);

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
  const modelsFrom = (test, url, savedUrl, provider) => {
    if (test && test !== "testing" && test.ok) return test.details || test.models?.map(name => ({ name, thinking: null }));
    if (statusResult?.ok && cfg?.llm_provider === provider && url === savedUrl) {
      return statusResult.details || statusResult.models?.map(name => ({ name, thinking: null }));
    }
    return null;
  };
  const ollamaModels = draft && modelsFrom(ollamaTest, draft.ollama_base_url, cfg?.ollama_base_url, "ollama");
  const respModels = draft && modelsFrom(respTest, draft.responses_base_url, cfg?.responses_base_url, "responses");
  const ollamaThinks = ollamaModels?.find(m => m.name === draft?.ollama_model)?.thinking ?? null;
  const respThinks = respModels?.find(m => m.name === draft?.responses_model)?.thinking ?? null;
  const respContext = respModels?.find(m => m.name === draft?.responses_model)?.context_length ?? null;
  if (draft?.llm_provider === "responses" && ["low", "medium", "high"].includes(draft.responses_reasoning_effort)
      && respThinks === false) {
    errors.responses_reasoning_effort = "This model doesn't support reasoning; set Thinking to Off or pick a model labelled think.";
  }
  if (draft?.llm_provider === "ollama" && draft.ollama_think && ollamaThinks === false) {
    // Ollama rejects think=true for models without the capability.
    errors.ollama_think = "This model doesn't support thinking; turn chain-of-thought off or pick a model labelled think.";
  }
  const errorCount = Object.keys(validate(draft, cfg)).length
    + (errors.ollama_think ? 1 : 0) + (errors.responses_reasoning_effort ? 1 : 0);

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
    const allowHttp = !!draft.responses_http_allowed_origin
      && draft.responses_http_allowed_origin === urlOrigin(draft.responses_base_url);
    try { setRespTest(await testResponses(draft.responses_base_url, draft.responses_api_key_input, allowHttp)); }
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
        responses_reasoning_effort: draft.responses_reasoning_effort || "",
        responses_max_output_tokens: Number(draft.responses_max_output_tokens) || 0,
        ...keyUpdate,
        ...s1TokenUpdate,
        self_update_repo: draft.self_update_repo || "",
        ...((draft.responses_http_allowed_origin || null) !== (cfg.responses_http_allowed_origin || null)
          ? { responses_http_allowed_origin: draft.responses_http_allowed_origin || "" } : {}),
        s1_enabled: draft.s1_enabled,
        ...(draft.s1_console_url ? { s1_console_url: draft.s1_console_url } : {}),
        s1_scope_type: draft.s1_scope_type,
        ...(draft.s1_scope_id ? { s1_scope_id: draft.s1_scope_id } : {}),
        s1_policy_id: (draft.s1_policy_id || "").trim(),
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
        repo_check_interval_hours: Number(draft.repo_check_interval_hours),
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
  // The window prompts must fit: Ollama's num_ctx override, or the context
  // the Responses server reports for the selected model.
  const effectiveCtx = isResponses ? respContext : numCtx;
  const overflowsCtx = !!effectiveCtx && promptTokens > effectiveCtx;
  const hint = { fontSize: 11.5, color: t.c.text3, marginTop: 6, lineHeight: 1.5 };

  return (
    <>
      <p className="muted" style={{ fontSize: ".86rem", margin: "0 0 var(--gap)" }}>
        Changes apply to the next analysis job. Worker settings apply after the worker restarts.
      </p>
      <div className="sgrid">

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
                {needsHttpException(draft, cfg) && (
                  draft.responses_http_allowed_origin === urlOrigin(draft.responses_base_url) ? (
                    <div role="note" style={{ ...hint, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                      color: t.sev.high.fg }}>
                      <span>⚠ Plain HTTP allowed for <code style={{ fontFamily: t.fontMono }}>
                        {prettyOrigin(draft.responses_http_allowed_origin)}</code>: the key and code are not encrypted in transit.</span>
                      <Btn theme={t} size="sm" variant="quiet"
                        onClick={() => update({ responses_http_allowed_origin: "" })}>Revoke</Btn>
                    </div>
                  ) : (
                    <div style={{ marginTop: 8 }}>
                      <Btn theme={t} size="sm" variant="danger" onClick={() => setConfirmHttp(true)}>
                        Allow plain HTTP for this host…
                      </Btn>
                    </div>
                  )
                )}
              </Field>
              {confirmHttp && (
                <Modal theme={t} title="Send over unencrypted HTTP?" onClose={() => setConfirmHttp(false)}
                  subtitle={prettyOrigin(urlOrigin(draft.responses_base_url))}>
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: t.c.text2 }}>
                    <p style={{ marginTop: 0 }}>Every review request to this host would travel <b>unencrypted</b>:</p>
                    <ul style={{ paddingLeft: 18, margin: "0 0 12px" }}>
                      <li>the <b>API key</b>, readable by anyone on the network path;</li>
                      <li>the <b>source code under review</b>, including whatever secrets it contains;</li>
                      <li>the <b>model&rsquo;s answers</b>, which someone in between could alter, e.g. to hide findings.</li>
                    </ul>
                    <p>Only allow this if the whole path to the server is a network you trust (for example a
                      campus gateway reached over the university network or VPN). It applies to this host only;
                      any other http:// address is still refused.</p>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
                    <Btn theme={t} onClick={() => setConfirmHttp(false)}>Cancel</Btn>
                    <Btn theme={t} variant="danger" onClick={() => {
                      update({ responses_http_allowed_origin: urlOrigin(draft.responses_base_url) });
                      setConfirmHttp(false);
                    }}>Yes, allow HTTP for this host</Btn>
                  </div>
                </Modal>
              )}

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
                <ConnectionResult theme={t} result={respTest} />
              </div>

              <Field theme={t} label="Model" hint="think = supports reasoning" error={errors.responses_model}>
                <ModelPicker theme={t} value={draft.responses_model} models={respModels}
                  onChange={v => update({ responses_model: v })} placeholder="e.g. gpt-5.1-codex" />
                {draft.responses_model && respModels && (
                  <div style={{ ...hint, display: "flex", alignItems: "center", gap: 8 }}>
                    <ThinkBadge theme={t} value={respThinks} />
                    {respThinks === null && "This server doesn't report whether the model can reason."}
                    {respContext && <span>· context window <b>{fmtK(respContext)} tokens</b>, set by the server</span>}
                  </div>
                )}
              </Field>
              <Field theme={t} label="Thinking" hint="reasoning effort, for models that reason"
                error={errors.responses_reasoning_effort}>
                <SelectInput theme={t} value={draft.responses_reasoning_effort || ""}
                  onChange={set("responses_reasoning_effort")}
                  options={[{ value: "", label: "Model default" }, { value: "none", label: "Off" },
                    { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
                    { value: "high", label: "High" }]} />
                <div style={hint}>
                  {!draft.responses_reasoning_effort
                    ? "Sends no reasoning setting, so the model's own default applies — a model that can think may still think."
                    : draft.responses_reasoning_effort === "none"
                      ? "Asks the model not to think (reasoning.effort: none). Not every server accepts this; if one rejects it, use Model default."
                      : "Higher effort gives deeper analysis but slower, costlier reviews."}
                </div>
              </Field>
              <Field theme={t} label="Max output tokens">
                <Slider theme={t} value={Number(draft.responses_max_output_tokens) || 0} steps={MAX_OUTPUT_STEPS}
                  format={fmtMaxOutput} onChange={v => update({ responses_max_output_tokens: v })} />
                <div style={hint}>
                  Caps each response, including reasoning tokens. Too low and reviews get cut off.
                </div>
              </Field>
              <div style={{ ...hint, marginTop: -4, marginBottom: 6 }}>
                <b>Context window:</b> {respContext
                  ? <>{fmtK(respContext)} tokens for this model, configured on the server. </>
                  : <>set by the server for each model. </>}
                The Responses API has no per-request setting for it (MindRouter, for example, applies its own
                per-model value), so use <i>Prompt size</i> below to control how much code goes into each request.
              </div>
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
                <ConnectionResult theme={t} result={ollamaTest} />
              </Field>
              <Field theme={t} label="Model" hint="think = supports chain-of-thought" error={errors.ollama_model}>
                <ModelPicker theme={t} value={draft.ollama_model} models={ollamaModels}
                  onChange={v => update({ ollama_model: v })} placeholder="e.g. qwen3:4b, llama3:8b" />
              </Field>
              <Field theme={t} label="Chain-of-thought" error={errors.ollama_think}
                hint={ollamaThinks === true ? "supported by this model"
                  : ollamaThinks === false ? "not supported by this model" : "for models that support thinking"}>
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
                    onChange={e => { set("s1_scope_id")(e); setS1Test(null); }} placeholder="numeric account or site ID" />
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

              <Field theme={t} label="Scanner policy ID"
                hint="from the console's CNS scanner policies; without it the CLI runs secret scanning only"
                error={errors.s1_policy_id}>
                <TextInput theme={t} value={draft.s1_policy_id || ""} mono
                  onChange={set("s1_policy_id")} placeholder="optional" />
              </Field>
              {!draft.s1_policy_id && draft.s1_scanners?.some(v => v !== "secret") && (
                <div role="note" style={{ marginTop: -6, marginBottom: 14, fontSize: 12, color: "var(--yellow)" }}>
                  IaC and vulnerability scans need a scanner policy ID; without one SentinelOne reports them as disabled.
                </div>
              )}

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

      <SectionCard theme={t} title="Self-update" subtitle="Custos reviewing its own updates">
        <div style={{ maxWidth: 600 }}>
          <Field theme={t} label="Custos source repository" hint="must be registered on the Repos page">
            <SelectInput theme={t} value={draft.self_update_repo || ""} onChange={set("self_update_repo")}
              options={[{ value: "", label: "Off — don't treat any repo as Custos itself" },
                ...repos.map(r => ({ value: r.repo_full_name, label: r.repo_full_name }))]} />
          </Field>
          <div style={{ ...hint, marginTop: -6 }}>
            Commits to this repo are scanned like any other. <code style={{ fontFamily: t.fontMono }}>./custos update</code>,
            run on the server from cron or systemd, deploys the latest <code style={{ fontFamily: t.fontMono }}>main</code> only
            when CI passed for that exact commit <b>and</b> an admin signed it off here, with no critical or high
            finding confirmed as real. Only admins can sign off this repo. A clean scan never deploys on its own.
          </div>
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
                ⚠ This is larger than the model&rsquo;s {fmtK(effectiveCtx)}-token context window, so
                prompts would be cut short. {isResponses ? "Lower this" : "Raise the window or lower this"}.
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

      <SectionCard theme={t} title="Repository updates"
        subtitle="Custos asks GitHub for new commits (default branch and open PRs); GitHub never needs to reach this server">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          <Field theme={t} label="Check every (hours)" hint="0 = only when someone presses Check for updates"
            error={errors.repo_check_interval_hours}>
            <TextInput theme={t} type="number" value={draft.repo_check_interval_hours ?? ""} onChange={set("repo_check_interval_hours")} mono />
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

      </div>

      {(dirty || fb) && (
        <div className="savebar">
          <span role="status" style={{
            color: fb?.type === "error" || errorCount ? "var(--crit)" : fb?.type === "success" ? "var(--ok)" : "var(--text2)" }}>
            {fb?.type === "error" ? fb.msg
              : errorCount ? `Fix ${errorCount} field${errorCount > 1 ? "s" : ""} before saving`
              : fb?.type === "success" && !dirty ? "✓ Saved"
              : "You have unsaved changes"}
          </span>
          {dirty && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Btn theme={t} onClick={handleDiscard} disabled={saving}>Discard</Btn>
              <Btn theme={t} variant="primary" onClick={handleSave} disabled={saving || errorCount > 0}>
                {saving ? "Saving…" : "Save changes"}
              </Btn>
            </div>
          )}
        </div>
      )}
    </>
  );
}

const TAB_ALIAS = { analysis: "config" };

export default function Settings() {
  const { user, logout } = useAuth();
  const { theme } = useTheme();
  const isAdmin   = user?.role === "admin";
  const t         = theme;
  const [params, setParams] = useSearchParams();
  const { guard } = useUnsavedGuard();

  const tabs = [
    { key: "account", label: "Account" },
    ...(isAdmin ? [
      { key: "users",  label: "Users" },
      { key: "config", label: "Analysis" },
    ] : []),
  ];
  // ?tab= deep-links (the command palette uses it); unknown or not-allowed tabs fall back to Account.
  const want = TAB_ALIAS[params.get("tab")] || params.get("tab");
  const tab = tabs.some((x) => x.key === want) ? want : "account";
  const setTab = (k) => setParams(k === "account" ? {} : { tab: k }, { replace: true });

  return (
    <PageWrap theme={t}>
      <PageHeader theme={t} title="Settings"
        subtitle={isAdmin ? "Your account, people, and the analysis engine" : "Manage your account"} />
      <Tabs theme={t} tabs={tabs} active={tab} onChange={(k) => k !== tab && guard(() => setTab(k))} />
      {tab === "account" && <AccountTab user={user} onLogout={logout} />}
      {tab === "users"   && isAdmin && <UsersTab currentUser={user?.username} />}
      {tab === "config"  && isAdmin && <AnalysisTab theme={t} />}
    </PageWrap>
  );
}
