import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../App.jsx";
import api, { getMe } from "../api/client.js";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || "/";

  useEffect(() => {
    if (user) navigate(from, { replace: true });
  }, [user]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.post("/auth/login", { username, password });
      const { access_token } = res.data;
      localStorage.setItem("custos_token", access_token);
      const userData = await getMe();
      login(access_token, userData);
      navigate(from, { replace: true });
    } catch (e) {
      setError(
        e.response?.status === 401
          ? "Invalid username or password"
          : e.response?.data?.detail || "Login failed"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg)",
      backgroundImage: "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(240,165,0,0.06), transparent)",
    }}>
      <div style={{ width: "100%", maxWidth: "360px", padding: "0 24px" }}>
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div style={{
            fontSize: "28px", fontWeight: 700, letterSpacing: "-0.03em",
            color: "var(--accent)", marginBottom: "4px",
            fontFamily: "var(--mono)",
          }}>
            CUSTOS
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-3)", letterSpacing: "0.15em" }}>
            SECURITY REVIEW SYSTEM
          </div>
        </div>

        <div style={{
          background: "var(--bg-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "32px",
        }}>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.12em", marginBottom: "6px" }}>
                USERNAME
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                required
                style={{
                  width: "100%", padding: "9px 12px",
                  background: "var(--bg-3)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", color: "var(--text)",
                  fontFamily: "var(--mono)", fontSize: "13px", outline: "none",
                  transition: "border-color 0.15s",
                }}
                onFocus={e => e.target.style.borderColor = "var(--border-2)"}
                onBlur={e => e.target.style.borderColor = "var(--border)"}
              />
            </div>

            <div style={{ marginBottom: "24px" }}>
              <label style={{ display: "block", fontSize: "10px", color: "var(--text-3)", letterSpacing: "0.12em", marginBottom: "6px" }}>
                PASSWORD
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                style={{
                  width: "100%", padding: "9px 12px",
                  background: "var(--bg-3)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", color: "var(--text)",
                  fontFamily: "var(--mono)", fontSize: "13px", outline: "none",
                  transition: "border-color 0.15s",
                }}
                onFocus={e => e.target.style.borderColor = "var(--border-2)"}
                onBlur={e => e.target.style.borderColor = "var(--border)"}
              />
            </div>

            {error && (
              <div style={{
                marginBottom: "16px", padding: "8px 12px",
                background: "var(--red-dim)", border: "1px solid #f8514933",
                borderRadius: "var(--radius)", color: "var(--red)", fontSize: "12px",
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%", padding: "10px",
                background: loading ? "var(--bg-3)" : "var(--accent-dim)",
                border: `1px solid ${loading ? "var(--border)" : "var(--accent)"}`,
                borderRadius: "var(--radius)",
                color: loading ? "var(--text-3)" : "var(--accent)",
                fontSize: "12px", fontWeight: 700, letterSpacing: "0.1em",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "var(--mono)",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { if (!loading) e.target.style.background = "rgba(240,165,0,0.2)"; }}
              onMouseLeave={e => { if (!loading) e.target.style.background = "var(--accent-dim)"; }}
            >
              {loading ? "AUTHENTICATING..." : "LOGIN"}
            </button>
          </form>
        </div>

        <div style={{ textAlign: "center", marginTop: "20px", fontSize: "11px", color: "var(--text-3)" }}>
          University IT Security Team
        </div>
      </div>
    </div>
  );
}
