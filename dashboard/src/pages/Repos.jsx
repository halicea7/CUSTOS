import React, { useEffect, useState } from "react";
import {
  listRepos, deleteRepo, updateRepo, checkRepoUpdates, addRepoToGroup, removeRepoFromGroup,
} from "../api/repos.js";
import { listGroups } from "../api/groups.js";
import { errorMessage } from "../api/errors.js";
import { useTheme, useAuth, Icon } from "../App.jsx";
import { Btn } from "../components/atoms.jsx";
import { PageHeader, PageWrap } from "../components/ui.jsx";
import AddRepoModal from "../components/AddRepoModal.jsx";

function fmtWhen(ts) {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function checkSummary(result) {
  const n = result.queued.length;
  if (!n) return "Up to date: no new commits.";
  return `Queued ${n} scan${n !== 1 ? "s" : ""}: ` + result.queued
    .map(q => q.pr_number ? `PR #${q.pr_number}` : q.branch).join(", ");
}

// Group chips, plus add/remove for the repo's owner or an admin. Analysts can
// only pick groups they belong to (that's all GET /groups returns for them).
function RepoGroups({ theme, repo, groups, canManage, onChanged }) {
  const [err, setErr] = useState("");
  const t = theme;
  const assigned = new Set((repo.groups || []).map(g => g.id));
  const choices = groups.filter(g => !assigned.has(g.id));

  const change = async (fn, groupId) => {
    setErr("");
    try { await fn(repo.id, groupId); onChanged(); }
    catch (e) { setErr(errorMessage(e, "Couldn't update groups")); }
  };

  if (!repo.groups?.length && !(canManage && choices.length)) return null;
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap", alignItems: "center", paddingLeft: 23 }}>
      {(repo.groups || []).map((g) => (
        <span key={g.id} style={{ display: "inline-flex", alignItems: "center", gap: 5,
          padding: "2px 9px", borderRadius: 999, fontSize: 11, fontWeight: 500,
          color: t.c.accent, background: t.c.accentBg }}>
          {g.name}
          {canManage && (
            <button aria-label={`Remove from ${g.name}`} title={`Remove from ${g.name}`}
              onClick={() => change(removeRepoFromGroup, g.id)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                color: "inherit", fontSize: 12, lineHeight: 1 }}>×</button>
          )}
        </span>
      ))}
      {canManage && choices.length > 0 && (
        <select value="" aria-label="Add to group"
          onChange={e => e.target.value && change(addRepoToGroup, e.target.value)}
          style={{ fontSize: 11, padding: "2px 6px", borderRadius: 999, cursor: "pointer",
            color: t.c.text2, background: "transparent", border: `1px dashed ${t.c.border2}`,
            fontFamily: t.fontUi }}>
          <option value="">+ Add to group</option>
          {choices.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      )}
      {err && <span style={{ fontSize: 11, color: "var(--red)" }}>{err}</span>}
    </div>
  );
}

function RepoRow({ theme, repo, groups, canManage, onToggle, onDelete, onChecked, last }) {
  const [confirming, setConfirming] = useState(false);
  const [hover,      setHover]      = useState(false);
  const [checking,   setChecking]   = useState(false);
  const [checkMsg,   setCheckMsg]   = useState(null);  // { ok, text }

  const checkNow = async () => {
    setChecking(true); setCheckMsg(null);
    try {
      const result = await checkRepoUpdates(repo.id);
      setCheckMsg({ ok: true, text: checkSummary(result) });
      onChecked();
    } catch (err) {
      setCheckMsg({ ok: false, text: errorMessage(err, "Check failed") });
    } finally {
      setChecking(false);
    }
  };
  const t = theme;
  const green = t.status.signed_off[t.mode === "light" ? "light" : "dark"];

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: "grid", gridTemplateColumns: GRID, gap: 14,
        alignItems: "center", padding: "14px 18px",
        borderBottom: last ? "none" : `1px solid ${t.c.border}`,
        background: hover ? t.c.raised : "transparent", transition: "background 0.12s",
        opacity: repo.enabled ? 1 : 0.62 }}>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <Icon name="repos" size={14} color={t.c.text3} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: t.c.text, fontFamily: t.fontMono,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
            {repo.repo_full_name}
          </span>
        </div>
        <RepoGroups theme={t} repo={repo} groups={groups} canManage={canManage} onChanged={onChecked} />
        {checkMsg && (
          <div role="status" style={{ marginTop: 7, paddingLeft: 23, fontSize: 12,
            color: checkMsg.ok ? t.c.text2 : "var(--red)" }}>
            {checkMsg.text}
          </div>
        )}
      </div>

      <span style={{ fontSize: 12, color: t.c.text3, fontFamily: t.fontMono }}>
        {repo.token_preview || "—"}
      </span>
      <span style={{ fontSize: 12.5, color: t.c.text2 }}>{repo.added_by}</span>
      <span title={repo.last_push_at ? `Last scan queued ${fmtWhen(repo.last_push_at)}` : undefined}
        style={{ fontSize: 12, color: t.c.text3 }}>{fmtWhen(repo.last_checked_at)}</span>

      <div style={{ display: "flex", alignItems: "center", gap: 14, justifyContent: "flex-end" }}>
        <Btn theme={t} size="sm" disabled={checking || !repo.enabled} onClick={checkNow}>
          {checking ? "Checking…" : "↻ Check for updates"}
        </Btn>
        <button onClick={() => onToggle(repo)} style={{ display: "inline-flex", alignItems: "center",
          gap: 6, background: "none", border: "none", cursor: "pointer", fontSize: 12.5,
          fontWeight: 500, fontFamily: t.fontUi, color: repo.enabled ? green : t.c.text3,
          padding: 0, transition: "opacity 0.12s" }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, flexShrink: 0,
            background: repo.enabled ? green : t.c.text3 }} />
          {repo.enabled ? "Enabled" : "Disabled"}
        </button>
        {confirming ? (
          <div style={{ display: "flex", gap: 6 }}>
            <Btn theme={t} variant="danger" size="sm" onClick={() => { onDelete(repo.id); setConfirming(false); }}>Confirm</Btn>
            <Btn theme={t} variant="quiet" size="sm" onClick={() => setConfirming(false)}>Cancel</Btn>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} style={{ background: "none", border: "none",
            cursor: "pointer", fontSize: 12.5, color: t.c.text3, fontFamily: t.fontUi, padding: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = t.c.text}
            onMouseLeave={e => e.currentTarget.style.color = t.c.text3}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

const GRID = "1fr 130px 100px 120px 330px";

export default function Repos() {
  const { theme }  = useTheme();
  const { user }   = useAuth();
  const [repos,     setRepos]     = useState([]);
  const [groups,    setGroups]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const t = theme;

  const load = () => {
    setLoading(true);
    listRepos().then(setRepos).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    listGroups().then(setGroups).catch(() => {});
  }, []);

  // Quiet refresh (no loading state) so a row's check result stays on screen.
  const refresh = () => { listRepos().then(setRepos).catch(() => {}); };

  const handleDelete = async (id) => {
    await deleteRepo(id).catch(() => {});
    setRepos(prev => prev.filter(r => r.id !== id));
  };

  const handleToggle = async (repo) => {
    const updated = await updateRepo(repo.id, { enabled: !repo.enabled }).catch(() => null);
    if (updated) setRepos(prev => prev.map(r => r.id === updated.id ? updated : r));
  };

  return (
    <PageWrap theme={t} max={1080}>
      <PageHeader theme={t} title="Repositories"
        subtitle={`${repos.length} ${repos.length === 1 ? "repository" : "repositories"} · checked for new commits on a schedule or on demand`}
        right={<Btn theme={t} variant="primary" onClick={() => setShowModal(true)}>+ Add repository</Btn>}
      />

      <div style={{ border: `1px solid ${t.c.border}`, borderRadius: t.radiusLg,
        overflow: "hidden", background: t.c.surface, boxShadow: t.c.shadow }}>
        {/* Header row */}
        <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 14,
          padding: "11px 18px", background: t.c.raised, borderBottom: `1px solid ${t.c.border}` }}>
          {["Repository", "Token", "Added by", "Last checked", ""].map((h, i) => (
            <span key={i} style={{ fontSize: 11, fontWeight: 600, color: t.c.text3,
              letterSpacing: "0.04em", textTransform: "uppercase",
              textAlign: i === 4 ? "right" : "left" }}>{h}</span>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: "40px", textAlign: "center", color: t.c.text3, fontSize: 13 }}>
            Loading…
          </div>
        ) : repos.length === 0 ? (
          <div style={{ padding: "56px 32px", textAlign: "center" }}>
            <div style={{ color: t.c.text3, fontSize: 13, marginBottom: 16 }}>
              No repositories connected yet.
            </div>
            <Btn theme={t} variant="primary" onClick={() => setShowModal(true)}>+ Add your first repo</Btn>
          </div>
        ) : (
          repos.map((repo, i) => (
            <RepoRow key={repo.id} theme={t} repo={repo} groups={groups}
              canManage={user?.role === "admin" || repo.added_by === user?.username}
              onToggle={handleToggle} onDelete={handleDelete} onChecked={refresh} last={i === repos.length - 1} />
          ))
        )}
      </div>

      {showModal && (
        <AddRepoModal
          onClose={() => setShowModal(false)}
          onAdded={(repo) => { setRepos(prev => [repo, ...prev]); setShowModal(false); }}
        />
      )}
    </PageWrap>
  );
}
