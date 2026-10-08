import React, { useCallback, useEffect } from "react";
import { Btn } from "../atoms.jsx";
import { downloadBlob, generateHtmlReport, generateMarkdown } from "./report.js";

export default function ReportModal({ theme, sub, findings, onClose }) {
  const slug = (sub.repo_full_name || "report").replace("/", "-");
  const sha = sub.commit_sha?.slice(0, 8) || "unknown";
  const basename = `custos-report-${slug}-${sha}`;
  const htmlContent = generateHtmlReport(sub, findings);
  const mdContent   = generateMarkdown(sub, findings);
  const printPdf = useCallback(() => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    iframe.contentDocument.open(); iframe.contentDocument.write(htmlContent); iframe.contentDocument.close();
    iframe.contentWindow.focus(); iframe.contentWindow.print();
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }, [htmlContent]);
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const t = theme;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "stretch", justifyContent: "flex-end" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "min(900px, 96vw)", background: t.c.surface,
        border: `1px solid ${t.c.border}`, display: "flex", flexDirection: "column",
        overflow: "hidden", boxShadow: t.c.shadowHi }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", borderBottom: `1px solid ${t.c.border}`, background: t.c.raised }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: t.c.text2 }}>
            SECURITY REPORT — {sub.repo_full_name}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Btn theme={t} size="sm" onClick={() => downloadBlob(mdContent, `${basename}.md`, "text/markdown")}>↓ Markdown</Btn>
            <Btn theme={t} size="sm" onClick={() => downloadBlob(htmlContent, `${basename}.html`, "text/html")}>↓ HTML</Btn>
            <Btn theme={t} size="sm" variant="primary" onClick={printPdf}>↓ PDF</Btn>
            <button onClick={onClose} style={{ background: "none", border: "none", color: t.c.text3,
              fontSize: 18, cursor: "pointer", padding: "2px 8px" }}>✕</button>
          </div>
        </div>
        <iframe srcDoc={htmlContent} sandbox="" style={{ flex: 1, border: "none", width: "100%", background: "#fff" }} title="Report preview" />
      </div>
    </div>
  );
}
