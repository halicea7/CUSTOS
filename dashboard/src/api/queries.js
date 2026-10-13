// TanStack Query hooks: one place for data fetching, caching and polling.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getActiveLlmJobs, getLlmRuns, getLlmStatus, getSubmission, getSubmissionFindings,
  listSubmissions, rerunLlm, signOff, deleteSubmission, getQueueOverview, getComparison,
  getChains, getSignoffs, returnSignoff,
} from "./submissions.js";
import { getFindingAudit, setDispositions } from "./findings.js";
import { getHealthStatus, getScanFindings, getServices, listScans, triggerScan } from "./health.js";
import { listGroups } from "./groups.js";
import { listRepos } from "./repos.js";

export const keys = {
  submissions: (filter, groupId, limit) => ["submissions", { filter, groupId, limit }],
  submission: (id) => ["submission", id],
  findings: (id) => ["submission", id, "findings"],
  comparison: (id) => ["submission", id, "compare"],
  chains: (id) => ["submission", id, "chains"],
  signoffs: (id) => ["submission", id, "signoffs"],
  audit: (findingId) => ["finding", findingId, "audit"],
  llmRuns: (id) => ["submission", id, "llm-runs"],
  llmStatus: (id) => ["submission", id, "llm-status"],
  llmActive: ["llm-active"],
  overview: (groupId) => ["submissions", "overview", { groupId }],
  groups: ["groups"],
  repos: ["repos"],
  healthStatus: ["health", "status"],
  services: ["health", "services"],
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

/** Status counts and the recent-activity feed (also drives the nav badge). */
export function useQueueOverview(groupId) {
  return useQuery({
    queryKey: keys.overview(groupId),
    queryFn: () => getQueueOverview(groupId),
    placeholderData: (prev) => prev,
    refetchInterval: (q) => {
      const c = q.state.data?.status_counts || {};
      return c.pending || c.analyzing ? 5000 : 30000;
    },
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

export function useRepos() {
  return useQuery({ queryKey: keys.repos, queryFn: listRepos, staleTime: 15000 });
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

/** What changed since the previous finished scan of the same repo. */
export function useComparison(id, status) {
  return useQuery({
    queryKey: keys.comparison(id),
    queryFn: () => getComparison(id),
    enabled: !IN_FLIGHT.has(status),
    staleTime: 60000,
  });
}

/** Attack chains (LLM estimates) of a finished run. */
export function useChains(id, status) {
  return useQuery({ queryKey: keys.chains(id), queryFn: () => getChains(id), enabled: !IN_FLIGHT.has(status) });
}

/** Each sign-off stage of a run with its comment, oldest first. */
export function useSignoffs(id) {
  return useQuery({ queryKey: keys.signoffs(id), queryFn: () => getSignoffs(id) });
}

/** Admin: send an analyst's sign-off back for more review. */
export function useReturnSignoff(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note) => returnSignoff(id, note),
    onSuccess: (updated) => {
      qc.setQueryData(keys.submission(id), updated);
      qc.invalidateQueries({ queryKey: keys.signoffs(id) });
      qc.invalidateQueries({ queryKey: ["submissions"] });
    },
  });
}

export function useFindingAudit(findingId) {
  return useQuery({ queryKey: keys.audit(findingId), queryFn: () => getFindingAudit(findingId), enabled: !!findingId });
}

/** Give one or more findings of a submission the same disposition. */
export function useDispose(submissionId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, disposition, note }) => setDispositions(ids, disposition, note),
    onSuccess: (updated) => {
      const byId = new Map(updated.map((f) => [f.id, f]));
      qc.setQueryData(keys.findings(submissionId), (old) => old?.map((f) => byId.get(f.id) || f));
      updated.forEach((f) => {
        qc.setQueryData(["finding", f.id], f);
        qc.invalidateQueries({ queryKey: keys.audit(f.id) });
      });
      qc.invalidateQueries({ queryKey: keys.submission(submissionId) });
      qc.invalidateQueries({ queryKey: ["submissions"] });
    },
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
      qc.invalidateQueries({ queryKey: keys.signoffs(id) });
      qc.invalidateQueries({ queryKey: ["submissions"] });
    },
  });
}

export function useDeleteSubmission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteSubmission(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: keys.submission(id) });
      qc.invalidateQueries({ queryKey: ["submissions"] });
    },
  });
}

/** Refresh everything about a submission (after a re-run or disposition). */
export function useInvalidateSubmission(id) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keys.submission(id) });
    qc.invalidateQueries({ queryKey: keys.findings(id) });
    qc.invalidateQueries({ queryKey: keys.comparison(id) });
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

/** API, database, Redis, worker, LLM and SentinelOne (admins only). */
export function useHealthServices() {
  return useQuery({ queryKey: keys.services, queryFn: getServices, refetchInterval: 30000 });
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
