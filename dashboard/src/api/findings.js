import api from "./client.js";

export async function getFinding(id) {
  const res = await api.get(`/findings/${id}`);
  return res.data;
}

export async function setDisposition(id, disposition, note) {
  const res = await api.patch(`/findings/${id}/disposition`, {
    disposition,
    note: note || null,
  });
  return res.data;
}

export async function getFindingAudit(id) {
  const res = await api.get(`/findings/${id}/audit`);
  return res.data;
}
