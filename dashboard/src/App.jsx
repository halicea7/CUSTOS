import React, { createContext, useContext, useState, useEffect } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  Link,
  useLocation,
} from "react-router-dom";
import { getMe } from "./api/client.js";
import Login from "./pages/Login.jsx";
import Queue from "./pages/Queue.jsx";
import Submission from "./pages/Submission.jsx";
import Finding from "./pages/Finding.jsx";
import Health from "./pages/Health.jsx";
import Repos from "./pages/Repos.jsx";
import Groups from "./pages/Groups.jsx";
import Settings from "./pages/Settings.jsx";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading

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
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-3)", fontFamily: "var(--mono)", letterSpacing: "0.1em", fontSize: "11px" }}>
      INITIALIZING...
    </div>
  );
}

function Nav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => { logout(); navigate("/login"); };

  return (
    <nav style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 24px", height: "48px", borderBottom: "1px solid var(--border)",
      background: "var(--bg-2)", position: "sticky", top: 0, zIndex: 100,
      backdropFilter: "blur(8px)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
        <Link to="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "var(--accent)", fontSize: "15px", fontWeight: 700, letterSpacing: "-0.02em" }}>CUSTOS</span>
          <span style={{ color: "var(--text-3)", fontSize: "11px" }}>v1.0</span>
        </Link>
        <span style={{ color: "var(--border-2)", fontSize: "11px" }}>/</span>
        {[
          { to: "/", label: "QUEUE" },
          { to: "/repos", label: "REPOS" },
          ...(user?.role === "admin" ? [
            { to: "/health", label: "HEALTH" },
            { to: "/groups", label: "GROUPS" },
          ] : []),
          { to: "/settings", label: "SETTINGS" },
        ].map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            style={{
              textDecoration: "none",
              fontSize: "11px",
              letterSpacing: "0.08em",
              color: (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to)) ? "var(--text)" : "var(--text-2)",
              borderBottom: (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to)) ? "1px solid var(--accent)" : "1px solid transparent",
              paddingBottom: "2px",
            }}
          >
            {label}
          </Link>
        ))}
      </div>
      {user && (
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <span style={{ color: "var(--text-3)", fontSize: "11px" }}>
            <span style={{ color: "var(--text-2)" }}>{user.username}</span>
            {user.role && <span style={{ marginLeft: "6px", color: "var(--text-3)" }}>({user.role})</span>}
          </span>
          <button onClick={handleLogout} style={{
            background: "none", border: "1px solid var(--border)", color: "var(--text-2)",
            padding: "4px 10px", borderRadius: "var(--radius)", cursor: "pointer",
            fontSize: "11px", letterSpacing: "0.06em", transition: "all 0.15s",
          }}
            onMouseEnter={e => { e.target.style.borderColor = "var(--border-2)"; e.target.style.color = "var(--text)"; }}
            onMouseLeave={e => { e.target.style.borderColor = "var(--border)"; e.target.style.color = "var(--text-2)"; }}
          >
            LOGOUT
          </button>
        </div>
      )}
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={
            <RequireAuth>
              <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
                <Nav />
                <main style={{ flex: 1 }}>
                  <Routes>
                    <Route path="/" element={<Queue />} />
                    <Route path="/submissions/:id" element={<Submission />} />
                    <Route path="/findings/:id" element={<Finding />} />
                    <Route path="/health" element={<RequireAdmin><Health /></RequireAdmin>} />
                    <Route path="/repos" element={<Repos />} />
                    <Route path="/groups" element={<RequireAdmin><Groups /></RequireAdmin>} />
                    <Route path="/settings" element={<Settings />} />
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
