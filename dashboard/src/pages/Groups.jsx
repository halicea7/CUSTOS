import React, { useEffect, useState } from "react";
import {
  listGroups, createGroup, updateGroup, deleteGroup,
  listMembers, addMember, removeMember,
} from "../api/groups.js";

const S = {
  input: {
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", padding: "7px 10px", color: "var(--text)",
    fontSize: "12px", fontFamily: "var(--mono)", outline: "none", width: "100%",
    boxSizing: "border-box",
  },
  btn: (v = "default") => ({
    padding: "6px 14px", borderRadius: "var(--radius)", cursor: "pointer",
    fontSize: "11px", fontFamily: "var(--mono)", letterSpacing: "0.06em",
    border: v === "primary" ? "none" : "1px solid var(--border)",
    background: v === "primary" ? "var(--accent)" : "transparent",
    color: v === "primary" ? "#000" : "var(--text-2)",
    fontWeight: v === "primary" ? 700 : 400,
  }),
};

function GroupCard({ group, onUpdated, onDeleted }) {
  const [expanded, setExpanded] = useState(false);
  const [members, setMembers] = useState(null);
  const [newUser, setNewUser] = useState("");
  const [adding, setAdding] = useState(false);
  const [editName, setEditName] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState("");

  const loadMembers = async () => {
    const m = await listMembers(group.id).catch(() => []);
    setMembers(m);
  };

  const handleExpand = () => {
    setExpanded(v => !v);
    if (!expanded && members === null) loadMembers();
  };

  const handleAddMember = async () => {
    if (!newUser.trim()) return;
    setAdding(true); setErr("");
    try {
      await addMember(group.id, newUser.trim());
      setNewUser("");
      loadMembers();
      onUpdated({ ...group, member_count: group.member_count + 1 });
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to add member.");
    } finally { setAdding(false); }
  };

  const handleRemoveMember = async (username) => {
    await removeMember(group.id, username).catch(() => {});
    setMembers(prev => prev.filter(m => m.username !== username));
    onUpdated({ ...group, member_count: Math.max(0, group.member_count - 1) });
  };

  const handleRename = async () => {
    if (!editName?.trim()) return setEditName(null);
    try {
      const updated = await updateGroup(group.id, { name: editName.trim() });
      onUpdated(updated);
      setEditName(null);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to rename.");
    }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", marginBottom: "10px" }}>
      <div
        onClick={handleExpand}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", background: "var(--bg-2)", cursor: "pointer",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "11px", color: "var(--text-3)", transition: "transform 0.15s", display: "inline-block", transform: expanded ? "rotate(90deg)" : "none" }}>▶</span>
          {editName !== null ? (
            <input
              autoFocus
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setEditName(null); }}
              onClick={e => e.stopPropagation()}
              style={{ ...S.input, width: "200px", padding: "3px 8px", fontSize: "13px" }}
            />
          ) : (
            <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text)", letterSpacing: "0.02em" }}>{group.name}</span>
          )}
          {group.description && (
            <span style={{ fontSize: "11px", color: "var(--text-3)" }}>{group.description}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "11px", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
            {group.member_count} member{group.member_count !== 1 ? "s" : ""}
          </span>
          <button
            onClick={e => { e.stopPropagation(); setEditName(group.name); }}
            style={{ ...S.btn(), padding: "3px 8px", fontSize: "10px" }}
          >RENAME</button>
          {confirming ? (
            <>
              <button onClick={e => { e.stopPropagation(); onDeleted(group.id); }} style={{ ...S.btn(), padding: "3px 8px", fontSize: "10px", color: "var(--red, #f87171)", borderColor: "var(--red, #f87171)" }}>CONFIRM</button>
              <button onClick={e => { e.stopPropagation(); setConfirming(false); }} style={{ ...S.btn(), padding: "3px 8px", fontSize: "10px" }}>CANCEL</button>
            </>
          ) : (
            <button onClick={e => { e.stopPropagation(); setConfirming(true); }} style={{ ...S.btn(), padding: "3px 8px", fontSize: "10px" }}>DELETE</button>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "14px 16px", borderTop: "1px solid var(--border)" }}>
          {err && <p style={{ color: "var(--red, #f87171)", fontSize: "12px", margin: "0 0 10px" }}>{err}</p>}

          <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input
              style={{ ...S.input, flex: 1 }}
              placeholder="username"
              value={newUser}
              onChange={e => setNewUser(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAddMember()}
            />
            <button onClick={handleAddMember} disabled={adding || !newUser.trim()} style={{ ...S.btn("primary"), opacity: adding || !newUser.trim() ? 0.5 : 1 }}>
              ADD
            </button>
          </div>

          {members === null ? (
            <p style={{ fontSize: "11px", color: "var(--text-3)" }}>Loading...</p>
          ) : members.length === 0 ? (
            <p style={{ fontSize: "11px", color: "var(--text-3)" }}>No members yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {members.map(m => (
                <div key={m.username} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "5px 10px", background: "var(--bg)", borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--text-2)" }}>{m.username}</span>
                  <button
                    onClick={() => handleRemoveMember(m.username)}
                    style={{ ...S.btn(), padding: "2px 8px", fontSize: "10px" }}
                  >REMOVE</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Groups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    listGroups().then(setGroups).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true); setErr("");
    try {
      const g = await createGroup({ name: name.trim(), description: description.trim() || undefined });
      setGroups(prev => [g, ...prev]);
      setName(""); setDescription("");
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to create group.");
    } finally { setCreating(false); }
  };

  const handleUpdated = (updated) => {
    setGroups(prev => prev.map(g => g.id === updated.id ? updated : g));
  };

  const handleDeleted = async (id) => {
    await deleteGroup(id).catch(() => {});
    setGroups(prev => prev.filter(g => g.id !== id));
  };

  return (
    <div style={{ padding: "24px", maxWidth: "800px", margin: "0 auto" }}>
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 700, letterSpacing: "0.04em", color: "var(--text)" }}>
          GROUPS
        </h1>
        <p style={{ margin: 0, fontSize: "12px", color: "var(--text-3)" }}>
          Organize users into teams. Members can see all repositories assigned to their group.
        </p>
      </div>

      <div style={{
        border: "1px solid var(--border)", borderRadius: "var(--radius)",
        padding: "16px", marginBottom: "24px", background: "var(--bg-2)",
      }}>
        <p style={{ margin: "0 0 12px", fontSize: "11px", color: "var(--text-2)", letterSpacing: "0.06em" }}>CREATE GROUP</p>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input
            style={{ ...S.input, flex: "1 1 160px" }}
            placeholder="Group name"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
          />
          <input
            style={{ ...S.input, flex: "2 1 200px" }}
            placeholder="Description (optional)"
            value={description}
            onChange={e => setDescription(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
          />
          <button onClick={handleCreate} disabled={creating || !name.trim()} style={{ ...S.btn("primary"), opacity: creating || !name.trim() ? 0.5 : 1 }}>
            CREATE
          </button>
        </div>
        {err && <p style={{ color: "var(--red, #f87171)", fontSize: "12px", margin: "8px 0 0" }}>{err}</p>}
      </div>

      {loading ? (
        <p style={{ color: "var(--text-3)", fontSize: "12px" }}>Loading...</p>
      ) : groups.length === 0 ? (
        <p style={{ color: "var(--text-3)", fontSize: "12px" }}>No groups yet.</p>
      ) : (
        groups.map(g => (
          <GroupCard key={g.id} group={g} onUpdated={handleUpdated} onDeleted={handleDeleted} />
        ))
      )}
    </div>
  );
}
