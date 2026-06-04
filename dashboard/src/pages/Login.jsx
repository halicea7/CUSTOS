import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth, useTheme, Icon } from "../App.jsx";
import api, { getMe } from "../api/client.js";
import { Btn } from "../components/atoms.jsx";
import { Field, TextInput } from "../components/ui.jsx";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const { login, user } = useAuth();
  const { theme } = useTheme();
  const navigate  = useNavigate();
  const location  = useLocation();
  const from      = location.state?.from?.pathname || "/";

  useEffect(() => { if (user) navigate(from, { replace: true }); }, [user]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
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

  const t = theme;

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: t.c.bg,
      backgroundImage: t.mode === "light"
        ? "radial-gradient(ellipse 70% 50% at 50% -10%, rgba(79,70,229,0.07), transparent)"
        : "radial-gradient(ellipse 70% 50% at 50% -10%, rgba(124,121,242,0.12), transparent)",
      padding: 24,
    }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 11, marginBottom: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, background: t.c.accent,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 8px 22px ${t.c.accent}44` }}>
              <Icon name="shield" size={22} color={t.c.accentText} />
            </div>
            <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em",
              color: t.c.text, fontFamily: t.fontDisplay }}>CUSTOS</span>
          </div>
          <div style={{ fontSize: 12.5, color: t.c.text3, letterSpacing: "0.04em" }}>
            Automated code security review
          </div>
        </div>

        {/* Card */}
        <form onSubmit={handleSubmit} style={{
          background: t.c.surface, border: `1px solid ${t.c.border}`,
          borderRadius: t.radiusLg, padding: 28, boxShadow: t.c.shadowHi,
        }}>
          <Field theme={t} label="Username">
            <TextInput theme={t} value={username} onChange={(e) => setUsername(e.target.value)}
              mono autoFocus />
          </Field>
          <Field theme={t} label="Password">
            <TextInput theme={t} type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} mono
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
          </Field>

          {error && (
            <div style={{ marginBottom: 16, padding: "9px 12px",
              background: `${t.sev.critical.fg}14`,
              border: `1px solid ${t.sev.critical.fg}33`,
              borderRadius: t.radius, color: t.sev.critical.fg, fontSize: 12.5 }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 22 }}>
            <Btn theme={t} variant="primary" full size="lg" onClick={handleSubmit} disabled={loading}>
              {loading ? "Authenticating…" : "Sign in"}
            </Btn>
          </div>
        </form>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 12, color: t.c.text3 }}>
          University IT · Security Team
        </div>
      </div>
    </div>
  );
}
