import React, { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { getFinding } from "../api/findings.js";
import { useDispose } from "../api/queries.js";
import { errorMessage } from "../api/errors.js";
import { ago } from "../components/queue/Board.jsx";
import {
  DecisionButtons, DispTag, FindingBody, SevPill, findingLoc, sourceLabel,
} from "../components/submission/FindingDetail.jsx";
import { useToast } from "../components/Toast.jsx";

const DONE_WORD = { false_positive: "false positive", confirmed: "confirmed", escalated: "escalated" };

export default function Finding() {
  const { id } = useParams();
  const navigate = useNavigate();
  const fromRepo = useLocation().state?.repoName;
  const toast = useToast();
  const [note, setNote] = useState("");

  const { data: f, error, isPending } = useQuery({ queryKey: ["finding", id], queryFn: () => getFinding(id) });
  const dispose = useDispose(f?.submission_id);

  if (error) return <div className="page"><div className="banner bad">{errorMessage(error, "Failed to load this finding")}</div></div>;
  if (isPending) return <div className="page"><div className="empty">Loading finding…</div></div>;

  const decide = (disposition) => dispose.mutate({ ids: [f.id], disposition, note }, {
    onSuccess: () => { toast(`Marked ${DONE_WORD[disposition]}`); setNote(""); },
    onError: (e) => toast(errorMessage(e, "Couldn't save the decision"), { bad: true }),
  });

  return (
    <div className="page glow" style={{ maxWidth: 1100 }}>
      <button className="back" onClick={() => navigate(`/submissions/${f.submission_id}`)}>
        ← {fromRepo || "Back to the run"}
      </button>
      <section className="panel" style={{ display: "flex", flexDirection: "column" }}>
        <div className="dh">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <SevPill sev={f.severity} /><span className="src">{sourceLabel(f.source)}</span>
              <DispTag disposition={f.disposition} />
            </div>
            <h2 style={{ overflowWrap: "anywhere" }}>{f.title}</h2>
            <div className="fsub" style={{ marginTop: 6 }}>
              {f.file_path && <span className="path">{findingLoc(f)}</span>}
              {f.cwe && <span>{f.cwe}</span>}
              {f.disposed_by && <span>decided by {f.disposed_by} {ago(f.disposed_at)}</span>}
            </div>
          </div>
        </div>
        <div className="db">
          <FindingBody finding={f} />
          <div className="field">
            <h3><label htmlFor="finding-note">Note</label></h3>
            <textarea id="finding-note" className="input textarea" rows={2} value={note}
              onChange={(e) => setNote(e.target.value)} placeholder="Why? (saved with your decision)" />
          </div>
        </div>
        <div className="df">
          <DecisionButtons current={f.disposition} disabled={dispose.isPending} onDecide={decide} />
        </div>
      </section>
    </div>
  );
}
