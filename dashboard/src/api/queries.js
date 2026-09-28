// TanStack Query hooks: one place for data fetching, caching and polling.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getActiveLlmJobs, getLlmRuns, getLlmStatus, getSubmission, getSubmissionFindings,
  listSubmissions, rerunLlm, signOff,
} from "./submissions.js";
import { getHealthStatus, getScanFindings, listScans, triggerScan } from "./health.js";
import { listGroups } from "./groups.js";

export const keys = {
  submissions: (filter, groupId, limit) => ["submissions", { filter, groupId, limit }],
  submission: (id) => ["submission", id],
  findings: (id) => ["submission", id, "findings"],
  llmRuns: (id) => ["submission", id, "llm-runs"],
  llmStatus: (id) => ["submission", id, "llm-status"],
  llmActive: ["llm-active"],
  groups: ["groups"],
  healthStatus: ["health", "status"],
  scans: ["health", "scans"],
  scanFindings: (id) => ["health", "scans", id, "findings"],
};

const IN_FLIGHT = new Set(["pending", "analyzing"]);
const LLM_ACTIVE = new Set(["queued", "running"]);

export function useSubmissions(filter, groupId, limit) {
  return useQuery({
    queryKey: keys.submissions(filter, groupId, limit),
    queryFn: () => listSubmissions(filter, groupId, limit),
    placeholderData: (prev) => prev,
    // Poll quickly while something is being analysed, slowly otherwise.
    refetchInterval: (q) =>
      q.state.data?.submissions?.some((s) => IN_FLIGHT.has(s.status)) ? 4000 : 30000,
  });
}

export function useActiveLlmJobs() {
  return useQuery({
    queryKey: keys.llmActive,
    queryFn: getActiveLlmJobs,
    select: (ids) => new Set(ids),
    refetchInterval: (q) => (q.state.data?.length ? 3000 : 15000),
  });
}

export function useGroups() {
  return useQuery({ queryKey: keys.groups, queryFn: listGroups, staleTime: 60000 });
}

export function useSubmission(id) {
  return useQuery({
    queryKey: keys.submission(id),
    queryFn: () => getSubmission(id),
    refetchInterval: (q) => (IN_FLIGHT.has(q.state.data?.status) ? 4000 : false),
  });
}

export function useSubmissionFindings(id, status) {
  return useQuery({
    queryKey: keys.findings(id),
    queryFn: () => getSubmissionFindings(id),
    enabled: !IN_FLIGHT.has(status),
  });
}

export function useLlmRuns(id, enabled) {
  return useQuery({ queryKey: keys.llmRuns(id), queryFn: () => getLlmRuns(id), enabled });
}

export function useLlmStatus(id) {
  return useQuery({
    queryKey: keys.llmStatus(id),
    queryFn: () => getLlmStatus(id),
    refetchInterval: (q) => (LLM_ACTIVE.has(q.state.data?.status) ? 2000 : false),
  });
}

export function useRerunLlm(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => rerunLlm(id),
    onSuccess: () => {
      qc.setQueryData(keys.llmStatus(id), { status: "queued", elapsed: 0, estimated: 90, progress: 0 });
      qc.invalidateQueries({ queryKey: keys.llmActive });
    },
  });
}

export function useSignOff(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note) => signOff(id, note),
    onSuccess: (updated) => {
      qc.setQueryData(keys.submission(id), updated);
      qc.invalidateQueries({ queryKey: ["submissions"] });
    },
  });
}

/** Refresh everything about a submission (after a re-run or disposition). */
export function useInvalidateSubmission(id) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keys.submission(id) });
    qc.invalidateQueries({ queryKey: ["submissions"] });
  };
}

export function useHealthStatus(polling) {
  return useQuery({
    queryKey: keys.healthStatus,
    queryFn: getHealthStatus,
    refetchInterval: polling ? 2000 : false,
  });
}

export function useScans(polling) {
  return useQuery({ queryKey: keys.scans, queryFn: listScans, refetchInterval: polling ? 2000 : false });
}

export function useScanFindings(scan) {
  return useQuery({
    queryKey: keys.scanFindings(scan?.id),
    queryFn: () => getScanFindings(scan.id),
    enabled: scan?.status === "complete",
  });
}

export function useTriggerScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: triggerScan,
    onSettled: () => qc.invalidateQueries({ queryKey: ["health"] }),
  });
}
