// ⌘K / Ctrl+K: jump to a run waiting for review, a repository or a page.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth, useUnsavedGuard } from "../App.jsx";
import { useRepos, useSubmissions } from "../api/queries.js";

const PAGES = [
  { label: "Queue", to: "/" },
  { label: "Repositories", to: "/repos" },
  { label: "Add repository", to: "/repos?add=1" },
  { label: "Health", to: "/health", admin: true },
  { label: "Run self-check", to: "/health", admin: true },
  { label: "Groups", to: "/groups", admin: true },
  { label: "Settings", to: "/settings" },
  { label: "Settings › Users", to: "/settings?tab=users", admin: true },
  { label: "Settings › Account", to: "/settings?tab=account" },
];
const refOf = (s) => (s.pr_number ? `PR #${s.pr_number}` : s.branch || "—");

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const { guard } = useUnsavedGuard();
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  const { data: subs } = useSubmissions(null, null, 500);
  const { data: repos = [] } = useRepos();

  useEffect(() => {
    if (open) { setQ(""); setSel(0); setTimeout(() => input.current?.focus(), 20); }
  }, [open]);

  const items = useMemo(() => {
    const runs = subs?.submissions || [];
    const latest = new Map();
    [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .forEach((s) => { if (!latest.has(s.repo_full_name)) latest.set(s.repo_full_name, s); });
    const waiting = runs.filter((s) => s.status === "needs_review").map((s) => ({
      sec: "Needs review", label: `${s.repo_full_name.split("/").pop()} · ${refOf(s)} · ${s.commit_sha.slice(0, 7)}`,
      right: `${s.finding_counts?.critical || 0} crit · ${s.finding_counts?.high || 0} high`, to: `/submissions/${s.id}`,
    }));
    const repoItems = repos.map((r) => {
      const s = latest.get(r.repo_full_name);
      return { sec: "Repositories", label: r.repo_full_name, right: s ? s.status.replace("_", " ") : "no scans yet",
        to: s ? `/submissions/${s.id}` : "/repos" };
    });
    const pages = PAGES.filter((p) => !p.admin || user?.role === "admin").map((p) => ({ sec: "Pages", ...p }));
    const needle = q.trim().toLowerCase();
    return [...waiting, ...repoItems, ...pages]
      .filter((i) => !needle || i.label.toLowerCase().includes(needle) || i.sec.toLowerCase().includes(needle))
      .slice(0, 16);
  }, [subs, repos, q, user]);

  const go = (item) => { onClose(); guard(() => navigate(item.to)); };
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((v) => Math.min(items.length - 1, v + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((v) => Math.max(0, v - 1)); }
    else if (e.key === "Enter" && items[sel]) { e.preventDefault(); go(items[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  let section = "";
  return (
    <>
      {open && <div className="palette-scrim" onClick={onClose} />}
      <div className={`palette ${open ? "show" : ""}`} role="dialog" aria-label="Search" aria-hidden={!open}>
        <input ref={input} value={q} placeholder="Jump to a repository, run or page…" aria-label="Search"
          onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKeyDown} tabIndex={open ? 0 : -1} />
        <div className="res" role="listbox">
          {items.length === 0 && <div className="empty">No matches</div>}
          {items.map((it, i) => {
            const head = it.sec !== section ? (section = it.sec) : null;
            return (
              <React.Fragment key={`${it.sec}-${it.label}-${i}`}>
                {head && <div className="sec">{head}</div>}
                <div role="option" aria-selected={i === sel} className={`it ${i === sel ? "on" : ""}`}
                  onMouseMove={() => sel !== i && setSel(i)} onClick={() => go(it)}>
                  {it.label}<span className="r">{it.right}</span>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </>
  );
}
