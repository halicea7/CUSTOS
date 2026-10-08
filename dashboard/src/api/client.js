import axios from "axios";

const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("custos_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      const url = err.config?.url || "";
      // A failed login is a 401 too; let the login form show the error.
      // The startup /auth/me check handles its own 401 (AuthProvider sends
      // the user to /login without a reload). And never reload /login
      // itself: that wipes whatever the user is typing.
      const handledElsewhere = url.endsWith("/auth/login") || url.endsWith("/auth/me");
      localStorage.removeItem("custos_token");
      if (!handledElsewhere && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export default api;

export async function getMe() {
  const res = await api.get("/auth/me");
  return res.data;
}
