import React, { useEffect, useState } from "react";
import { listRepos, deleteRepo, updateRepo } from "../api/repos.js";
import { useAuth } from "../App.jsx";
import { useTheme, Icon } from "../App.jsx";
import { Btn } from "../components/atoms.jsx";
import { PageHeader, PageWrap } from "../components/ui.jsx";
import AddRepoModal from "../components/AddRepoModal.jsx";

function fmtDay(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function RepoRow({ theme, repo, onToggle, onDelete, last }) {
  const [confirming, setConfirming] = useState(false);
  const [hover,      setHover]      = useState(false);
  const t = theme;
  const green = t.status.signed_off[t.mode === "light" ? "light" : "dark"];

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: "grid", gridTemplateColumns: "1fr 130px 110px 110px 190px", gap: 14,
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
        {repo.groups?.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap", paddingLeft: 23 }}>
            {repo.groups.map((g) => (
              <span key={g.id} style={{ display: "inline-flex", alignItems: "center",
                padding: "2px 9px", borderRadius: 999, fontSize: 11, fontWeight: 500,
                color: t.c.accent, background: t.c.accentBg }}>{g.name}</span>
            ))}
          </div>
        )}
      </div>

      <span style={{ fontSize: 12, color: t.c.text3, fontFamily: t.fontMono }}>
        {repo.token_preview || "—"}
      </span>
      <span style={{ fontSize: 12.5, color: t.c.text2 }}>{repo.added_by}</span>
      <span style={{ fontSize: 12, color: t.c.text3 }}>{fmtDay(repo.last_push_at)}</span>

      <div style={{ display: "flex", alignItems: "center", gap: 14, justifyContent: "flex-end" }}>
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

export default function Repos() {
  const { user }   = useAuth();
  const { theme }  = useTheme();
  const isAdmin    = user?.role === "admin";
  const [repos,     setRepos]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const t = theme;

  const load = () => {
    setLoading(true);
    listRepos().then(setRepos).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

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
        subtitle={`${repos.length} repositories connected to webhooks`}
        right={<Btn theme={t} variant="primary" onClick={() => setShowModal(true)}>+ Add repository</Btn>}
      />

      <div style={{ border: `1px solid ${t.c.border}`, borderRadius: t.radiusLg,
        overflow: "hidden", background: t.c.surface, boxShadow: t.c.shadow }}>
        {/* Header row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 110px 110px 190px", gap: 14,
          padding: "11px 18px", background: t.c.raised, borderBottom: `1px solid ${t.c.border}` }}>
          {["Repository", "Token", "Added by", "Last push", ""].map((h, i) => (
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
            <RepoRow key={repo.id} theme={t} repo={repo}
              onToggle={handleToggle} onDelete={handleDelete} last={i === repos.length - 1} />
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
