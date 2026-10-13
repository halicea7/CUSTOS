import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMember, createGroup, deleteGroup, listMembers, removeMember, updateGroup,
} from "../api/groups.js";
import { getUsers } from "../api/settings.js";
import { keys, useGroups, useRepos, useSubmissions } from "../api/queries.js";
import { errorMessage } from "../api/errors.js";
import { Icon, useTheme } from "../App.jsx";
import { Modal } from "../components/ui.jsx";
import { ArmedButton, Status, groupByRepo } from "../components/queue/Board.jsx";
import { useToast } from "../components/Toast.jsx";

const plural = (k, w) => `${k} ${w}${k !== 1 ? "s" : ""}`;
const initial = (name) => (name || "?")[0].toUpperCase();
const membersKey = (id) => ["groups", id, "members"];

function RenameModal({ group, onClose, onSaved }) {
  const { theme } = useTheme();
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr("");
    try { await updateGroup(group.id, { name: name.trim(), description: desc.trim() }); onSaved(name.trim()); }
    catch (e) { setErr(errorMessage(e, "Couldn't rename the group")); }
    finally { setBusy(false); }
  };
  return (
    <Modal theme={theme} title="Edit group" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label htmlFor="g-name">Name</label>
          <input id="g-name" className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()} />
        </div>
        <div className="field">
          <label htmlFor="g-desc">Description</label>
          <input id="g-desc" className="input" value={desc} onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()} />
        </div>
        {err && <div className="result bad">{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

function GroupCard({ group, users, repos, latestByRepo, defaultOpen }) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [renaming, setRenaming] = useState(false);
  const { data: members = [], isPending } = useQuery({
    queryKey: membersKey(group.id), queryFn: () => listMembers(group.id),
  });

  const names = new Set(members.map((m) => m.username));
  const free = users.filter((u) => !names.has(u.username));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.groups });
    qc.invalidateQueries({ queryKey: keys.repos });
  };
  const act = async (fn, done, fail) => {
    try { await fn(); toast(done); refresh(); } catch (e) { toast(errorMessage(e, fail), { bad: true }); }
  };

  return (
    <div className="gcard">
      <div className="gh" onClick={() => setOpen((v) => !v)} role="button" aria-expanded={open} tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setOpen((v) => !v)}>
        <div className="gicon"><Icon name="groups" size={18} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: "var(--text)" }}>{group.name}</div>
          {group.description && <div className="muted" style={{ fontSize: ".84rem" }}>{group.description}</div>}
        </div>
        <div className="stack hide-sm">
          {members.slice(0, 4).map((m) => <div key={m.username} className="avatar" title={m.username}>{initial(m.username)}</div>)}
        </div>
        <span className="muted" style={{ fontSize: ".84rem", whiteSpace: "nowrap" }}>
          {plural(group.member_count ?? members.length, "member")} · {plural(repos.length, "repo")}
        </span>
        <span className="chev" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }}>›</span>
      </div>

      {open && (
        <div className="gb">
          <div>
            <div className="lbl" style={{ marginBottom: 8 }}>Members</div>
            <select className="input" value="" style={{ width: "100%", marginBottom: 10 }} aria-label="Add a member"
              disabled={!free.length}
              onChange={(e) => {
                const u = e.target.value;
                if (u) act(() => addMember(group.id, u), `Added ${u} to ${group.name}`, "Couldn't add the member");
              }}>
              <option value="">{free.length ? "Add a member…" : "Everyone is already a member"}</option>
              {free.map((u) => <option key={u.username} value={u.username}>{u.username} ({u.role})</option>)}
            </select>
            {isPending ? <div className="muted">Loading…</div> : members.length === 0 ? (
              <div className="muted" style={{ fontSize: ".86rem" }}>No members yet.</div>
            ) : members.map((m) => (
              <div key={m.username} className="member">
                <div className="avatar" style={{ width: 26, height: 26, fontSize: ".7rem" }}>{initial(m.username)}</div>
                <span className="mono" style={{ fontSize: ".88rem", color: "var(--text2)" }}>{m.username}</span>
                <ArmedButton label="Remove" confirm="Confirm remove"
                  onConfirm={() => act(() => removeMember(group.id, m.username), `Removed ${m.username} from ${group.name}`, "Couldn't remove the member")} />
              </div>
            ))}
          </div>
          <div>
            <div className="lbl" style={{ marginBottom: 8 }}>Repositories</div>
            {repos.length ? repos.map((r) => {
              const latest = latestByRepo.get(r.repo_full_name);
              return (
                <div key={r.id} className="member" style={{ cursor: "pointer" }}
                  onClick={() => navigate(latest ? `/submissions/${latest.id}` : "/repos")}
                  title={latest ? "Open the latest scan" : "Open Repositories"}>
                  <span style={{ fontWeight: 500, color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.repo_full_name}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: ".8rem" }}>
                    {latest ? <Status status={latest.status} /> : <span className="muted">no scans</span>}
                  </span>
                </div>
              );
            }) : <div className="muted" style={{ fontSize: ".86rem" }}>None yet. Share repositories from the Repositories page.</div>}
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="btn sm" onClick={() => setRenaming(true)}>Rename</button>
              <ArmedButton label="Delete group" confirm="Confirm delete" className="btn sm danger"
                onConfirm={() => act(() => deleteGroup(group.id), `Deleted ${group.name}`, "Couldn't delete the group")} />
            </div>
          </div>
        </div>
      )}
      {renaming && (
        <RenameModal group={group} onClose={() => setRenaming(false)}
          onSaved={(name) => { setRenaming(false); toast(`Saved ${name}`); refresh(); }} />
      )}
    </div>
  );
}

export default function Groups() {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState(null);

  const { data: groups = [], isPending, error } = useGroups();
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: getUsers, staleTime: 60000 });
  const { data: repos = [] } = useRepos();
  const { data: subsData } = useSubmissions(null, null, 500);
  const latestByRepo = useMemo(
    () => new Map(groupByRepo(subsData?.submissions || []).map((r) => [r.name, r.latest])),
    [subsData],
  );

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true); setErr("");
    try {
      const g = await createGroup({ name: name.trim(), description: desc.trim() || undefined });
      setName(""); setDesc(""); setCreated(g.id);
      toast(`Created ${g.name}`);
      qc.invalidateQueries({ queryKey: keys.groups });
    } catch (e) {
      setErr(errorMessage(e, "Couldn't create the group"));
    } finally { setCreating(false); }
  };

  return (
    <div className="page glow">
      <div className="top">
        <div>
          <h1>Groups</h1>
          <div className="subt">Members see every repository shared with their group</div>
        </div>
      </div>

      <section className="panel panel-b" style={{ marginBottom: "var(--gap)" }}>
        <div className="row-form">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name"
            aria-label="Group name" onKeyDown={(e) => e.key === "Enter" && create()} />
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)"
            aria-label="Description" style={{ flex: "2 1 240px" }} onKeyDown={(e) => e.key === "Enter" && create()} />
          <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={create} disabled={creating || !name.trim()}>
            Create group
          </button>
        </div>
        {err && <div className="result bad" style={{ marginTop: 10 }}>{err}</div>}
      </section>

      {error && <div className="banner bad">{errorMessage(error, "Failed to load groups")}</div>}
      {isPending ? <div className="empty">Loading…</div> : groups.length === 0 ? (
        <div className="panel"><div className="empty">No groups yet. Create one above, then add members and share repositories with it.</div></div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 640px), 1fr))", gap: "var(--gap)", alignItems: "start" }}>
          {groups.map((g, i) => (
            <GroupCard key={g.id} group={g} users={users} defaultOpen={g.id === created || (i === 0 && groups.length === 1)}
              repos={repos.filter((r) => (r.groups || []).some((x) => x.id === g.id))} latestByRepo={latestByRepo} />
          ))}
        </div>
      )}
    </div>
  );
}
