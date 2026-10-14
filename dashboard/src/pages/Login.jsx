import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router";
import { useAuth, useTheme, Icon } from "../App.jsx";
import api, { getMe } from "../api/client.js";
import { errorMessage } from "../api/errors.js";
import LavaBackground from "../components/LavaBackground.jsx";

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

  useEffect(() => { if (user) navigate(from, { replace: true }); }, [user, from, navigate]);

  // The line under the box is set in Settings; shown once loaded so it never flashes the default.
  const [footer, setFooter] = useState("");
  useEffect(() => {
    api.get("/auth/branding").then((r) => setFooter(r.data.login_footer || "")).catch(() => {});
  }, []);

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
          : errorMessage(e, "Login failed")
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <LavaBackground light={theme.mode === "light"} />
      <div className="login-veil" />
      <div className="login-box">
        <div className="login-logo">
          <div className="row">
            <div className="mark"><Icon name="shield" size={22} color="#fff" /></div>
            <b>CUSTOS</b>
          </div>
          <small>Automated code security review</small>
        </div>

        <form className="login-card" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="login-user">Username</label>
            <input id="login-user" className="input mono" autoComplete="username" autoFocus
              value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="login-pw">Password</label>
            <input id="login-pw" className="input mono" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <div className="result bad" role="alert">{error}</div>}
          <button type="submit" className="btn primary full lg" disabled={loading}>
            {loading ? <><span className="spin" /> Signing in</> : "Sign in"}
          </button>
        </form>

        {footer && <div className="login-foot">{footer}</div>}
      </div>
    </div>
  );
}
