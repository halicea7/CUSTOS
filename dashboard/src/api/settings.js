import api from "./client.js";

export const getUsers = () => api.get("/settings/users").then(r => r.data);
export const createUser = (body) => api.post("/settings/users", body).then(r => r.data);
export const updateUserRole = (id, role) => api.patch(`/settings/users/${id}/role`, { role }).then(r => r.data);
export const deleteUser = (id) => api.delete(`/settings/users/${id}`);
export const changePassword = (body) => api.patch("/settings/me/password", body);
export const getConfig = () => api.get("/settings/config").then(r => r.data);
export const updateConfig = (body) => api.patch("/settings/config", body).then(r => r.data);
export const testOllama = (url) => api.get("/settings/config/test-ollama", { params: { url } }).then(r => r.data);
export const testS1 = (body) => api.post("/settings/config/test-s1", body).then(r => r.data);
export const testResponses = (base_url, api_key) =>
  api.post("/settings/config/test-responses", { base_url, api_key: api_key || null }).then(r => r.data);
