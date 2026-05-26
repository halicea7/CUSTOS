import api from "./client.js";

export const listGroups = () => api.get("/groups").then(r => r.data);
export const createGroup = (body) => api.post("/groups", body).then(r => r.data);
export const updateGroup = (id, body) => api.patch(`/groups/${id}`, body).then(r => r.data);
export const deleteGroup = (id) => api.delete(`/groups/${id}`);
export const listMembers = (id) => api.get(`/groups/${id}/members`).then(r => r.data);
export const addMember = (id, username) => api.post(`/groups/${id}/members`, { username });
export const removeMember = (id, username) => api.delete(`/groups/${id}/members/${username}`);
