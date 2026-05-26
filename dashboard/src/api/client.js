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
      localStorage.removeItem("custos_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default api;

export async function getMe() {
  const res = await api.get("/auth/me");
  return res.data;
}
