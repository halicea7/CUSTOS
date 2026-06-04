import React, { createContext, useContext, useState, useEffect } from "react";
import {
  BrowserRouter, Routes, Route, Navigate,
  useNavigate, useLocation,
} from "react-router-dom";
import { getMe } from "./api/client.js";
import { makeTheme, applyCssVars } from "./theme.js";
import Login from "./pages/Login.jsx";
import Queue from "./pages/Queue.jsx";
import Submission from "./pages/Submission.jsx";
import Finding from "./pages/Finding.jsx";
import Health from "./pages/Health.jsx";
import Repos from "./pages/Repos.jsx";
import Groups from "./pages/Groups.jsx";
import Settings from "./pages/Settings.jsx";

// ── Auth context ──────────────────────────────────────────────────────────────

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);

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
  const logout = () => {
    localStorage.removeItem("custos_token");
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

// ── Theme context ─────────────────────────────────────────────────────────────

const ThemeCtx = createContext(null);
export const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }) {
  const [mode, setMode] = useState(
    () => localStorage.getItem("custos_mode") || "dark"
  );
  const theme = makeTheme(mode);

  useEffect(() => {
    localStorage.setItem("custos_mode", mode);
    applyCssVars(theme);
  }, [mode]);

  useEffect(() => { applyCssVars(theme); }, []);

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

function ModeToggle({ theme, mode, setMode }) {
  return (
    <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 999,
      background: theme.c.raised2, border: `1px solid ${theme.c.border}` }}>
      {[{ k: "light", icon: "sun" }, { k: "dark", icon: "moon" }].map((o) => {
        const on = mode === o.k;
        return (
          <button key={o.k} onClick={() => setMode(o.k)} title={`${o.k} mode`} style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            gap: 5, padding: "5px 10px", borderRadius: 999, cursor: "pointer",
            border: "none", background: on ? theme.c.surface : "transparent",
            color: on ? theme.c.accent : theme.c.text3,
            boxShadow: on ? theme.c.shadow : "none", transition: "all 0.14s",
            fontSize: 11, fontWeight: 600, fontFamily: theme.fontUi,
          }}>
            <Icon name={o.icon} size={13} color={on ? theme.c.accent : theme.c.text3} />
            <span style={{ textTransform: "capitalize" }}>{o.k}</span>
          </button>
        );
      })}
    </div>
  );
}

function SideRail({ theme, mode, setMode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const section = activeSection(location.pathname);

  const handleLogout = () => { logout(); navigate("/login"); };

  return (
    <aside style={{
      width: 220, flexShrink: 0, borderRight: `1px solid ${theme.c.border}`,
      background: theme.c.surface, display: "flex", flexDirection: "column",
      padding: "20px 14px", position: "sticky", top: 0, height: "100vh",
    }}>
      {/* Logo */}
      <div style={{ padding: "0 8px 22px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: theme.c.accent,
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="shield" size={17} color={theme.c.accentText} />
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em",
            color: theme.c.text, fontFamily: theme.fontDisplay }}>CUSTOS</span>
          <span style={{ fontSize: 10, color: theme.c.text3, fontFamily: theme.fontMono }}>v1.0</span>
        </div>
      </div>

      {/* Nav */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {NAV.filter((n) => !n.admin || user?.role === "admin").map((n) => {
          const on = section === n.id;
          return (
            <button key={n.id} onClick={() => navigate(n.path)} style={{
              display: "flex", alignItems: "center", gap: 11, padding: "9px 11px",
              borderRadius: theme.radius, cursor: "pointer", border: "none", textAlign: "left",
              background: on ? theme.c.accentBg : "transparent",
              color: on ? theme.c.accent : theme.c.text2,
              fontSize: 13.5, fontWeight: on ? 600 : 500, fontFamily: theme.fontUi,
              transition: "all 0.14s",
            }}
              onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = theme.c.raised; }}
              onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}>
              <Icon name={n.icon} size={17} color={on ? theme.c.accent : theme.c.text3} />
              {n.label}
            </button>
          );
        })}
      </div>

      {/* Bottom */}
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <ModeToggle theme={theme} mode={mode} setMode={setMode} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 8px",
          borderTop: `1px solid ${theme.c.border}` }}>
          {/* Avatar initials */}
          <div style={{ width: 32, height: 32, borderRadius: 999, background: theme.c.accentBg,
            color: theme.c.accent, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 700, fontFamily: theme.fontDisplay, flexShrink: 0 }}>
            {(user?.username || "?")[0].toUpperCase()}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12.5, color: theme.c.text, fontWeight: 600,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {user?.username}
            </div>
            <div style={{ fontSize: 11, color: theme.c.text3, textTransform: "capitalize" }}>
              {user?.role}
            </div>
          </div>
          <button onClick={handleLogout} title="Log out" style={{
            background: "none", border: "none", cursor: "pointer",
            color: theme.c.text3, padding: 4, display: "flex",
          }}
            onMouseEnter={(e) => e.currentTarget.style.color = theme.c.text}
            onMouseLeave={(e) => e.currentTarget.style.color = theme.c.text3}>
            <Icon name="logout" size={17} />
          </button>
        </div>
      </div>
    </aside>
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
              <div style={{ display: "flex", minHeight: "100vh", background: theme.c.bg }}>
                <SideRail theme={theme} mode={mode} setMode={setMode} />
                <main style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
                  <Routes>
                    <Route path="/"                 element={<Queue />} />
                    <Route path="/submissions/:id"  element={<Submission />} />
                    <Route path="/findings/:id"     element={<Finding />} />
                    <Route path="/health"           element={<RequireAdmin><Health /></RequireAdmin>} />
                    <Route path="/repos"            element={<Repos />} />
                    <Route path="/groups"           element={<RequireAdmin><Groups /></RequireAdmin>} />
                    <Route path="/settings"         element={<Settings />} />
                  </Routes>
                </main>
              </div>
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
      <AppShell />
    </ThemeProvider>
  );
}
