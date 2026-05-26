import React, { useEffect, useState } from "react";
import { listRepos, deleteRepo, updateRepo } from "../api/repos.js";
import { useAuth } from "../App.jsx";
import AddRepoModal from "../components/AddRepoModal.jsx";

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function RepoRow({ repo, isAdmin, onDelete, onToggle }) {
  const [confirming, setConfirming] = useState(false);

  const canEdit = isAdmin || repo.added_by === repo._currentUser;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 140px 120px 90px 110px",
      gap: "12px",
      alignItems: "center",
      padding: "10px 16px",
      borderBottom: "1px solid var(--border)",
      fontSize: "12px",
    }}>
      <div>
        <div style={{ color: "var(--text)", fontFamily: "var(--mono)", fontWeight: 600, marginBottom: "3px" }}>
          {repo.repo_full_name}
        </div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {repo.groups.map(g => (
            <span key={g.id} style={{
              padding: "1px 6px", borderRadius: "3px", fontSize: "10px",
              background: "rgba(255,160,0,0.12)", color: "var(--accent)",
              border: "1px solid rgba(255,160,0,0.25)",
            }}>{g.name}</span>
          ))}
        </div>
      </div>
      <div style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: "11px" }}>
        {repo.token_preview}
      </div>
      <div style={{ color: "var(--text-3)", fontSize: "11px" }}>
        {repo.added_by}
      </div>
      <div style={{ color: "var(--text-3)", fontSize: "11px" }}>
        {fmtDate(repo.last_push_at)}
      </div>
      <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
        <button
          onClick={() => onToggle(repo)}
          style={{
            padding: "3px 8px", borderRadius: "var(--radius)", cursor: "pointer",
            fontSize: "10px", fontFamily: "var(--mono)",
            border: "1px solid var(--border)",
            background: "transparent",
            color: repo.enabled ? "var(--text-2)" : "var(--text-3)",
          }}
        >
          {repo.enabled ? "ENABLED" : "DISABLED"}
        </button>
        {confirming ? (
          <>
            <button onClick={() => { onDelete(repo.id); setConfirming(false); }} style={{
              padding: "3px 8px", borderRadius: "var(--radius)", cursor: "pointer",
              fontSize: "10px", fontFamily: "var(--mono)",
              border: "1px solid var(--red, #f87171)", background: "transparent", color: "var(--red, #f87171)",
            }}>CONFIRM</button>
            <button onClick={() => setConfirming(false)} style={{
              padding: "3px 8px", borderRadius: "var(--radius)", cursor: "pointer",
              fontSize: "10px", fontFamily: "var(--mono)",
              border: "1px solid var(--border)", background: "transparent", color: "var(--text-3)",
            }}>CANCEL</button>
          </>
        ) : (
          <button onClick={() => setConfirming(true)} style={{
            padding: "3px 8px", borderRadius: "var(--radius)", cursor: "pointer",
            fontSize: "10px", fontFamily: "var(--mono)",
            border: "1px solid var(--border)", background: "transparent", color: "var(--text-3)",
          }}>REMOVE</button>
        )}
      </div>
    </div>
  );
}

export default function Repos() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

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
    <div style={{ padding: "24px", maxWidth: "1100px", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "16px", fontWeight: 700, letterSpacing: "0.04em", color: "var(--text)" }}>
            REPOSITORIES
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--text-3)" }}>
            {isAdmin ? "All connected repositories" : "Your repositories and group repositories"}
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          style={{
            padding: "8px 16px", borderRadius: "var(--radius)", cursor: "pointer",
            fontSize: "11px", fontFamily: "var(--mono)", fontWeight: 700, letterSpacing: "0.06em",
            border: "none", background: "var(--accent)", color: "#000",
          }}
        >
          + ADD REPO
        </button>
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 140px 120px 90px 110px",
          gap: "12px",
          padding: "8px 16px",
          background: "var(--bg-2)",
          borderBottom: "1px solid var(--border)",
          fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.08em",
        }}>
          <span>REPOSITORY</span>
          <span>TOKEN</span>
          <span>ADDED BY</span>
          <span>LAST PUSH</span>
          <span style={{ textAlign: "right" }}>ACTIONS</span>
        </div>

        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)", fontSize: "12px" }}>
            Loading...
          </div>
        ) : repos.length === 0 ? (
          <div style={{ padding: "48px 32px", textAlign: "center" }}>
            <p style={{ color: "var(--text-3)", fontSize: "13px", margin: "0 0 12px" }}>No repositories connected yet.</p>
            <button
              onClick={() => setShowModal(true)}
              style={{
                padding: "8px 16px", borderRadius: "var(--radius)", cursor: "pointer",
                fontSize: "11px", fontFamily: "var(--mono)", fontWeight: 700,
                border: "none", background: "var(--accent)", color: "#000",
              }}
            >
              + ADD YOUR FIRST REPO
            </button>
          </div>
        ) : (
          repos.map(repo => (
            <RepoRow
              key={repo.id}
              repo={repo}
              isAdmin={isAdmin}
              onDelete={handleDelete}
              onToggle={handleToggle}
            />
          ))
        )}
      </div>

      {showModal && (
        <AddRepoModal
          onClose={() => setShowModal(false)}
          onAdded={(repo) => { setRepos(prev => [repo, ...prev]); setShowModal(false); }}
        />
      )}
    </div>
  );
}
