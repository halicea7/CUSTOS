import api from "./client.js";

export async function getHealthStatus() {
  const res = await api.get("/health/status");
  return res.data;
}

export async function listScans() {
  const res = await api.get("/health/scans");
  return res.data;
}

export async function getScanFindings(scanId) {
  const res = await api.get(`/health/scans/${scanId}/findings`);
  return res.data;
}

export async function triggerScan() {
  const res = await api.post("/health/scan");
  return res.data;
}
