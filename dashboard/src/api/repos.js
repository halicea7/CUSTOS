import api from "./client.js";

export const listRepos = () => api.get("/repos").then(r => r.data);
export const addRepo = (body) => api.post("/repos", body).then(r => r.data);
export const updateRepo = (id, body) => api.patch(`/repos/${id}`, body).then(r => r.data);
export const deleteRepo = (id) => api.delete(`/repos/${id}`);
export const validateToken = (body) => api.post("/repos/validate-token", body).then(r => r.data);
export const addRepoToGroup = (repoId, groupId) => api.post(`/repos/${repoId}/groups/${groupId}`);
export const removeRepoFromGroup = (repoId, groupId) => api.delete(`/repos/${repoId}/groups/${groupId}`);
