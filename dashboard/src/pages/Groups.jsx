import React, { useEffect, useState } from "react";
import {
  listGroups, createGroup, updateGroup, deleteGroup,
  listMembers, addMember, removeMember,
} from "../api/groups.js";
import { useTheme, Icon } from "../App.jsx";
import { Btn, Avatar } from "../components/atoms.jsx";
import { PageHeader, PageWrap, SectionCard, TextInput } from "../components/ui.jsx";

function GroupCard({ theme, group, preloadedMembers = [], onUpdated, onDeleted }) {
  const [expanded,   setExpanded]   = useState(false);
  const [members,    setMembers]    = useState(null);
  const [newUser,    setNewUser]    = useState("");
  const [adding,     setAdding]     = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editName,   setEditName]   = useState(null);
  const [err,        setErr]        = useState("");
  const t = theme;

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
      setNewUser(""); await loadMembers();
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
      onUpdated(updated); setEditName(null);
    } catch (e) { setErr(e?.response?.data?.detail || "Failed to rename."); }
  };

  return (
    <div style={{ border: `1px solid ${t.c.border}`, borderRadius: t.radiusLg,
      overflow: "hidden", marginBottom: 12, background: t.c.surface, boxShadow: t.c.shadow }}>
      {/* Header row */}
      <div onClick={handleExpand} style={{ display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "15px 18px", cursor: "pointer",
        userSelect: "none", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13, minWidth: 0 }}>
          <span style={{ color: t.c.text3, fontSize: 10, transition: "transform 0.18s",
            transform: expanded ? "rotate(90deg)" : "none", display: "inline-block" }}>▶</span>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: t.c.accentBg,
            color: t.c.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon name="groups" size={18} color={t.c.accent} />
          </div>
          <div style={{ minWidth: 0 }}>
            {editName !== null ? (
              <input autoFocus value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setEditName(null); }}
                onClick={e => e.stopPropagation()}
                style={{ fontSize: 15, fontWeight: 600, color: t.c.text,
                  background: t.c.bg, border: `1px solid ${t.c.accent}`,
                  borderRadius: t.radius / 2, padding: "2px 8px", outline: "none",
                  fontFamily: t.fontDisplay, width: "100%" }} />
            ) : (
              <div style={{ fontSize: 15, fontWeight: 600, color: t.c.text, fontFamily: t.fontDisplay }}>
                {group.name}
              </div>
            )}
            {group.description && (
              <div style={{ fontSize: 12.5, color: t.c.text3, marginTop: 2 }}>{group.description}</div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }} onClick={e => e.stopPropagation()}>
          {/* Avatar stack — shows real initials from preloaded members */}
          <div style={{ display: "flex" }}>
            {preloadedMembers.slice(0, 4).map((username, i) => (
              <div key={username} style={{ marginLeft: i ? -8 : 0, borderRadius: 999,
                border: `2px solid ${t.c.surface}` }}>
                <Avatar theme={t} name={username} size={26} />
              </div>
            ))}
          </div>
          <span style={{ fontSize: 12.5, color: t.c.text3, whiteSpace: "nowrap" }}>
            {group.member_count} member{group.member_count !== 1 ? "s" : ""}
          </span>
          <Btn theme={t} variant="quiet" size="sm"
            onClick={e => { e.stopPropagation(); setEditName(group.name); }}>Rename</Btn>
          {confirming ? (
            <>
              <Btn theme={t} variant="danger" size="sm" onClick={() => onDeleted(group.id)}>Confirm</Btn>
              <Btn theme={t} variant="quiet" size="sm" onClick={() => setConfirming(false)}>Cancel</Btn>
            </>
          ) : (
            <Btn theme={t} variant="quiet" size="sm" onClick={() => setConfirming(true)}>Delete</Btn>
          )}
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: "16px 18px", borderTop: `1px solid ${t.c.border}`,
          background: t.c.raised }}>
          {err && <div style={{ color: t.sev.critical.fg, fontSize: 12, marginBottom: 10 }}>{err}</div>}

          <div style={{ display: "flex", gap: 8, marginBottom: 14, maxWidth: 420 }}>
            <TextInput theme={t} value={newUser} onChange={e => setNewUser(e.target.value)}
              placeholder="Add member by username" mono
              onKeyDown={e => e.key === "Enter" && handleAddMember()} />
            <Btn theme={t} variant="primary" onClick={handleAddMember} disabled={adding || !newUser.trim()}>
              Add
            </Btn>
          </div>

          {members === null ? (
            <div style={{ fontSize: 11, color: t.c.text3 }}>Loading…</div>
          ) : members.length === 0 ? (
            <div style={{ fontSize: 11, color: t.c.text3 }}>No members yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {members.map((m) => (
                <div key={m.username} style={{ display: "flex", alignItems: "center",
                  justifyContent: "space-between", padding: "8px 12px",
                  background: t.c.surface, border: `1px solid ${t.c.border}`,
                  borderRadius: t.radius }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar theme={t} name={m.username} size={26} />
                    <span style={{ fontSize: 13, color: t.c.text2, fontFamily: t.fontMono }}>
                      {m.username}
                    </span>
                  </div>
                  <Btn theme={t} variant="quiet" size="sm" onClick={() => handleRemoveMember(m.username)}>
                    Remove
                  </Btn>
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
  const { theme }     = useTheme();
  const [groups,       setGroups]     = useState([]);
  const [membersMap,   setMembersMap] = useState({});  // {groupId: [username, ...]}
  const [loading,      setLoading]    = useState(true);
  const [name,         setName]       = useState("");
  const [desc,         setDesc]       = useState("");
  const [creating,     setCreating]   = useState(false);
  const [err,          setErr]        = useState("");
  const t = theme;

  useEffect(() => {
    listGroups()
      .then(async (gs) => {
        setGroups(gs);
        // Load first 4 members of each group for the avatar stack
        const map = {};
        await Promise.all(gs.map(async (g) => {
          try {
            const members = await listMembers(g.id);
            map[g.id] = members.slice(0, 4).map(m => m.username);
          } catch { map[g.id] = []; }
        }));
        setMembersMap(map);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true); setErr("");
    try {
      const g = await createGroup({ name: name.trim(), description: desc.trim() || undefined });
      setGroups(prev => [g, ...prev]);
      setName(""); setDesc("");
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to create group.");
    } finally { setCreating(false); }
  };

  const handleUpdated = (updated) => setGroups(prev => prev.map(g => g.id === updated.id ? updated : g));
  const handleDeleted = async (id) => {
    await deleteGroup(id).catch(() => {});
    setGroups(prev => prev.filter(g => g.id !== id));
  };

  return (
    <PageWrap theme={t} max={840}>
      <PageHeader theme={t} title="Groups"
        subtitle="Organize users into teams. Members see every repository assigned to their group." />

      <SectionCard theme={t} title="Create group">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 170px" }}>
            <TextInput theme={t} value={name} onChange={e => setName(e.target.value)}
              placeholder="Group name" onKeyDown={e => e.key === "Enter" && handleCreate()} />
          </div>
          <div style={{ flex: "2 1 220px" }}>
            <TextInput theme={t} value={desc} onChange={e => setDesc(e.target.value)}
              placeholder="Description (optional)" onKeyDown={e => e.key === "Enter" && handleCreate()} />
          </div>
          <Btn theme={t} variant="primary" onClick={handleCreate}
            disabled={creating || !name.trim()}>Create</Btn>
        </div>
        {err && <div style={{ color: t.sev.critical.fg, fontSize: 12, marginTop: 10 }}>{err}</div>}
      </SectionCard>

      {loading ? (
        <div style={{ color: t.c.text3, fontSize: 13 }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div style={{ color: t.c.text3, fontSize: 13 }}>No groups yet.</div>
      ) : (
        groups.map(g => (
          <GroupCard key={g.id} theme={t} group={g}
            preloadedMembers={membersMap[g.id] || []}
            onUpdated={handleUpdated} onDeleted={handleDeleted} />
        ))
      )}
    </PageWrap>
  );
}
