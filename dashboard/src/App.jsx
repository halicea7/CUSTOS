import React, { createContext, lazy, Suspense, useCallback, useContext, useState, useEffect, useMemo } from "react";
import {
  BrowserRouter, Routes, Route, Navigate,
  useNavigate, useLocation,
} from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getMe } from "./api/client.js";
import { useQueueOverview } from "./api/queries.js";
import { makeTheme, applyCssVars } from "./theme.js";
import Login from "./pages/Login.jsx";
import Queue from "./pages/Queue.jsx";
import { Modal } from "./components/ui.jsx";
import { Btn } from "./components/atoms.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import { TourProvider } from "./components/tour/Tour.jsx";

// Less-visited pages load on demand to keep the initial bundle small.
const Submission = lazy(() => import("./pages/Submission.jsx"));
const Finding    = lazy(() => import("./pages/Finding.jsx"));
const Health     = lazy(() => import("./pages/Health.jsx"));
const Repos      = lazy(() => import("./pages/Repos.jsx"));
const Groups     = lazy(() => import("./pages/Groups.jsx"));
const Settings   = lazy(() => import("./pages/Settings.jsx"));

// ── Auth context ──────────────────────────────────────────────────────────────

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);
  const queryClient = useQueryClient();

  useEffect(() => {
    const token = localStorage.getItem("custos_token");
    if (!token) { setUser(null); return; }
    getMe()
      .then((u) => setUser(u))
      .catch(() => { localStorage.removeItem("custos_token"); setUser(null); });
  }, []);

  const login = (token, userData) => {
    localStorage.setItem("custos_token", token);
    setUser(userData);
  };
  // Merge a fresh /auth/me-shaped object (e.g. after the tour is marked done).
  const updateUser = (patch) => setUser((u) => (u ? { ...u, ...patch } : u));
  const logout = () => {
    localStorage.removeItem("custos_token");
    queryClient.clear(); // don't leak the previous user's cached data
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, login, logout, updateUser }}>
      {children}
    </AuthCtx.Provider>
  );
}

// ── Unsaved-changes guard ─────────────────────────────────────────────────────
// Pages with a form call setDirty(); in-app navigation goes through guard(),
// which asks before discarding edits. Closing/reloading the tab gets the
// browser's own prompt. (BrowserRouter has no useBlocker, hence this.)

const UnsavedCtx = createContext({ setDirty: () => {}, guard: (fn) => fn() });
export const useUnsavedGuard = () => useContext(UnsavedCtx);

function UnsavedChangesProvider({ theme, children }) {
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const guard = useCallback((fn) => (dirty ? setPending(() => fn) : fn()), [dirty]);
  const value = useMemo(() => ({ setDirty, guard }), [guard]);

  const discard = () => {
    const next = pending;
    setPending(null);
    setDirty(false);
    next();
  };

  return (
    <UnsavedCtx.Provider value={value}>
      {children}
      {pending && (
        <Modal theme={theme} title="Discard unsaved changes?"
          subtitle="You have changes on this page that haven't been saved." onClose={() => setPending(null)}>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Btn theme={theme} onClick={() => setPending(null)}>Keep editing</Btn>
            <Btn theme={theme} variant="danger" onClick={discard}>Discard changes</Btn>
          </div>
        </Modal>
      )}
    </UnsavedCtx.Provider>
  );
}

// ── Theme context ─────────────────────────────────────────────────────────────

const ThemeCtx = createContext(null);
export const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem("custos_mode") || "dark"; } catch { return "dark"; }
  });
  const theme = useMemo(() => makeTheme(mode), [mode]);

  useEffect(() => {
    try { localStorage.setItem("custos_mode", mode); } catch { /* storage unavailable */ }
    applyCssVars(theme);
  }, [mode, theme]);

  const setModeAndPersist = (m) => setMode(m);

  return (
    <ThemeCtx.Provider value={{ theme, mode, setMode: setModeAndPersist }}>
      {children}
    </ThemeCtx.Provider>
  );
}

// ── Auth guards ───────────────────────────────────────────────────────────────

function RequireAuth({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <Splash />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { user } = useAuth();
  if (user === undefined) return <Splash />;
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

function Splash() {
  const { theme } = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
      height: "100vh", color: theme.c.text3, fontFamily: theme.fontMono,
      letterSpacing: "0.1em", fontSize: "11px", background: theme.c.bg }}>
      INITIALIZING...
    </div>
  );
}

// ── Icon ──────────────────────────────────────────────────────────────────────

export function Icon({ name, size = 16, color = "currentColor" }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: color, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "queue":    return <svg {...p}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" /></svg>;
    case "repos":    return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><line x1="4" y1="9" x2="20" y2="9" /></svg>;
    case "health":   return <svg {...p}><polyline points="3 12 8 12 11 5 14 19 17 12 21 12" /></svg>;
    case "groups":   return <svg {...p}><circle cx="8" cy="9" r="3" /><circle cx="16" cy="9" r="3" /><path d="M3 19c0-2.5 2.2-4 5-4s5 1.5 5 4" /><path d="M14 15.2c2.4.2 4 1.6 4 3.8" /></svg>;
    case "settings": return <svg {...p}><line x1="4" y1="8" x2="20" y2="8" /><circle cx="9" cy="8" r="2.2" fill={color} /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="15" cy="16" r="2.2" fill={color} /></svg>;
    case "shield":   return <svg {...p}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></svg>;
    case "sun":      return <svg {...p}><circle cx="12" cy="12" r="4" /><line x1="12" y1="3" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="21" /><line x1="3" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="21" y2="12" /><line x1="5.6" y1="5.6" x2="7" y2="7" /><line x1="17" y1="17" x2="18.4" y2="18.4" /><line x1="5.6" y1="18.4" x2="7" y2="17" /><line x1="17" y1="7" x2="18.4" y2="5.6" /></svg>;
    case "moon":     return <svg {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5z" /></svg>;
    case "logout":   return <svg {...p}><path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" /><polyline points="9 8 5 12 9 16" /><line x1="5" y1="12" x2="15" y2="12" /></svg>;
    default: return null;
  }
}

// ── Nav items ─────────────────────────────────────────────────────────────────

const NAV = [
  { id: "queue",    label: "Queue",    icon: "queue",    path: "/" },
  { id: "repos",    label: "Repos",    icon: "repos",    path: "/repos" },
  { id: "health",   label: "Health",   icon: "health",   path: "/health",   admin: true },
  { id: "groups",   label: "Groups",   icon: "groups",   path: "/groups",   admin: true },
  { id: "settings", label: "Settings", icon: "settings", path: "/settings" },
];

function activeSection(pathname) {
  if (pathname === "/") return "queue";
  if (pathname.startsWith("/submissions") || pathname.startsWith("/findings")) return "queue";
  if (pathname.startsWith("/repos"))    return "repos";
  if (pathname.startsWith("/health"))   return "health";
  if (pathname.startsWith("/groups"))   return "groups";
  if (pathname.startsWith("/settings")) return "settings";
  return "queue";
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function SideRail({ mode, setMode, onSearch }) {
  const { user, logout } = useAuth();
  const { data: overview } = useQueueOverview(null);
  const needsReview = overview?.status_counts?.needs_review || 0;
  const navigate = useNavigate();
  const location = useLocation();
  const section = activeSection(location.pathname);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const { guard } = useUnsavedGuard();
  const handleLogout = () => guard(() => { logout(); navigate("/login"); });

  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => guard(() => navigate("/"))}>
        <span className="logo"><Icon name="shield" size={16} color="#fff" /></span>
        CUSTOS <small>v1.1</small>
      </button>
      <button className="kbar" onClick={onSearch} data-tour="search">
        ⌕ Search… <span className="kbd">{mac ? "⌘K" : "Ctrl K"}</span>
      </button>

      <nav style={{ display: "flex", flexDirection: "column", gap: 3 }} data-tour="nav">
        {NAV.filter((n) => !n.admin || user?.role === "admin").map((n) => (
          <button key={n.id} className={`navlink ${section === n.id ? "on" : ""}`}
            aria-current={section === n.id ? "page" : undefined}
            onClick={() => guard(() => navigate(n.path))}>
            <Icon name={n.icon} size={17} />
            {n.label}
            {n.id === "queue" && needsReview > 0 && (
              <span className="count" title={`${needsReview} run${needsReview !== 1 ? "s" : ""} need review`}>
                {needsReview}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="seg" style={{ display: "flex" }}>
          {[{ k: "light", icon: "sun" }, { k: "dark", icon: "moon" }].map((o) => (
            <button key={o.k} className={mode === o.k ? "on" : ""} style={{ flex: 1 }}
              onClick={() => setMode(o.k)} aria-pressed={mode === o.k}>
              <Icon name={o.icon} size={13} /><span style={{ textTransform: "capitalize" }}>{o.k}</span>
            </button>
          ))}
        </div>
        <div className="me">
          <div className="avatar">{(user?.username || "?")[0].toUpperCase()}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: ".9rem", fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis" }}>{user?.username}</div>
            <div className="muted" style={{ fontSize: ".78rem", textTransform: "capitalize" }}>{user?.role}</div>
          </div>
          <button className="link" onClick={handleLogout} title="Log out" aria-label="Log out"
            style={{ display: "flex", padding: 4 }}>
            <Icon name="logout" size={17} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Shell({ theme, mode, setMode, children }) {
  const [search, setSearch] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <TourProvider>
    <div style={{ display: "flex", minHeight: "100vh", background: theme.c.bg }}>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs><linearGradient id="custos-ring" x1="0" x2="1">
          <stop offset="0" stopColor="#7c5cff" /><stop offset="1" stopColor="#c084fc" />
        </linearGradient></defs>
      </svg>
      <SideRail mode={mode} setMode={setMode} onSearch={() => setSearch(true)} />
      <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
      <CommandPalette open={search} onClose={() => setSearch(false)} />
    </div>
    </TourProvider>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

function AppShell() {
  const { theme, mode, setMode } = useTheme();

  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={
            <RequireAuth>
              <UnsavedChangesProvider theme={theme}>
              <Shell theme={theme} mode={mode} setMode={setMode}>
                  <Suspense fallback={<Splash />}>
                  <Routes>
                    <Route path="/"                 element={<Queue />} />
                    <Route path="/submissions/:id"  element={<Submission />} />
                    <Route path="/findings/:id"     element={<Finding />} />
                    <Route path="/health"           element={<RequireAdmin><Health /></RequireAdmin>} />
                    <Route path="/repos"            element={<Repos />} />
                    <Route path="/groups"           element={<RequireAdmin><Groups /></RequireAdmin>} />
                    <Route path="/settings"         element={<Settings />} />
                  </Routes>
                  </Suspense>
              </Shell>
              </UnsavedChangesProvider>
            </RequireAuth>
          } />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </ThemeProvider>
  );
}
