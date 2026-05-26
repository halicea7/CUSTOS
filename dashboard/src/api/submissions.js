import api from "./client.js";

export async function listSubmissions(statusFilter, groupId) {
  const params = {};
  if (statusFilter) params.status = statusFilter;
  if (groupId) params.group_id = groupId;
  const res = await api.get("/submissions", { params });
  return res.data;
}

export async function getSubmission(id) {
  const res = await api.get(`/submissions/${id}`);
  return res.data;
}

export async function getSubmissionFindings(id) {
  const res = await api.get(`/submissions/${id}/findings`);
  return res.data;
}

export async function signOff(id, note) {
  const res = await api.post(`/submissions/${id}/signoff`, { note: note || null });
  return res.data;
}

export async function getActiveLlmJobs() {
  const res = await api.get("/submissions/llm-active");
  return res.data.active; // string[]
}

export async function rerunLlm(id) {
  const res = await api.post(`/submissions/${id}/rerun-llm`);
  return res.data;
}

export async function getLlmStatus(id) {
  const res = await api.get(`/submissions/${id}/llm-status`);
  return res.data;
}

export async function getLlmRuns(id) {
  const res = await api.get(`/submissions/${id}/llm-runs`);
  return res.data;
}
