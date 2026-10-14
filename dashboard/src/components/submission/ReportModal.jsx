import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLlmRuns } from "../../api/queries.js";
import { downloadBlob, generateMarkdown } from "./report.js";
import { reportHtml } from "./ReportDoc.jsx";

// PDF = the same HTML, printed landscape by the browser ("Save as PDF").
function printHtml(html) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(html); doc.close();
  // Give the layout a moment before the print dialog snapshots it.
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 2000);
  }, 150);
}

export default function ReportModal({ sub, findings, chains = [], cmp, signoffs = [], onClose }) {
  const { data: runs = [] } = useLlmRuns(sub.id, true);
  const [menu, setMenu] = useState(false);
  const [bwPreview, setBwPreview] = useState(false);
  const menuRef = useRef(null);
  const data = useMemo(() => ({ sub, findings, chains, cmp, signoffs, runs }), [sub, findings, chains, cmp, signoffs, runs]);
  const html = useMemo(() => reportHtml(data, { bw: bwPreview }), [data, bwPreview]);
  const base = `custos-report-${(sub.repo_full_name || "report").replace("/", "-")}-${sub.commit_sha?.slice(0, 8) || "unknown"}`;

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { if (menu) setMenu(false); else onClose(); } };
    const onDown = (e) => { if (menu && !menuRef.current?.contains(e.target)) setMenu(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [menu, onClose]);

  const pdf = (bw) => { setMenu(false); printHtml(reportHtml(data, { bw })); };

  return (
    <div className="report-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="report-panel" role="dialog" aria-modal="true" aria-label="Security report">
        <div className="report-bar">
          <b>Security report</b>
          <span className="muted mono" style={{ fontSize: ".8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sub.repo_full_name} @ {sub.commit_sha?.slice(0, 8)}
          </span>
          <span style={{ flex: 1 }} />
          <div className="seg" title="Preview in colour or black and white">
            <button className={!bwPreview ? "on" : ""} onClick={() => setBwPreview(false)}>Colour</button>
            <button className={bwPreview ? "on" : ""} onClick={() => setBwPreview(true)}>B&amp;W</button>
          </div>
          <button className="btn sm" onClick={() => downloadBlob(generateMarkdown(sub, findings), `${base}.md`, "text/markdown")}>↓ Markdown</button>
          <button className="btn sm" onClick={() => downloadBlob(reportHtml(data, { bw: bwPreview }), `${base}.html`, "text/html")}>↓ HTML</button>
          <div className="split" ref={menuRef}>
            <button className="btn sm primary" onClick={() => pdf(bwPreview)} title="Opens the print dialog: choose Save as PDF">
              ↓ PDF{bwPreview ? " (B&W)" : ""}
            </button>
            <button className="btn sm primary caret" aria-label="PDF options" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>▾</button>
            {menu && (
              <div className="split-menu" role="menu">
                <button role="menuitem" onClick={() => pdf(false)}><b>Colour</b><span>For reading on screen</span></button>
                <button role="menuitem" onClick={() => pdf(true)}><b>Black &amp; white</b><span>For paper: no coloured ink</span></button>
              </div>
            )}
          </div>
          <button className="link" onClick={onClose} aria-label="Close" style={{ fontSize: "1.3rem", lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>
        <iframe className="report-frame" srcDoc={html} sandbox="" title="Report preview" />
      </div>
    </div>
  );
}
