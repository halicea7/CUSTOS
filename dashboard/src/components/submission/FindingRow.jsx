import React, { useState } from "react";
import { DispositionTag, Severity } from "../atoms.jsx";

export default function FindingRow({ theme, finding, onOpen, last }) {
  const [hover, setHover] = useState(false);
  const t = theme;
  const meta = t.sev[finding.severity];
  return (
    <div onClick={() => onOpen(finding)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 14,
        alignItems: "center", padding: "15px 18px", cursor: "pointer",
        background: hover ? t.c.raised : "transparent",
        borderBottom: last ? "none" : `1px solid ${t.c.border}`,
        borderLeft: `3px solid ${hover ? meta.solid : "transparent"}`, transition: "all 0.12s" }}>
      <Severity theme={t} severity={finding.severity} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: t.c.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{finding.title}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11.5, color: t.c.text2, fontFamily: t.fontMono, whiteSpace: "nowrap" }}>
            {finding.file_path}{finding.line_start ? `:${finding.line_start}` : ""}
          </span>
          <span style={{ fontSize: 10, color: t.c.text3, fontFamily: t.fontMono,
            letterSpacing: "0.04em", textTransform: "uppercase" }}>[{finding.source}]</span>
          {finding.cwe && (
            <span style={{ fontSize: 11, color: t.c.text3, fontFamily: t.fontMono }}>{finding.cwe}</span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {finding.disposition
          ? <DispositionTag theme={t} disposition={finding.disposition} />
          : <span style={{ fontSize: 11, color: t.c.text3, fontFamily: t.fontMono }}>untriaged</span>}
        <span style={{ color: t.c.text3, fontSize: 16 }}>›</span>
      </div>
    </div>
  );
}
