import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { getSubmission, getSubmissionFindings, rerunLlm, getLlmStatus, getLlmRuns } from "../api/submissions.js";
import SeverityBadge from "../components/SeverityBadge.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import FindingCard from "../components/FindingCard.jsx";
import SignOffPanel from "../components/SignOffPanel.jsx";

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const SOURCE_LABELS = {
  semgrep: "Semgrep (SAST)",
  gitleaks: "Gitleaks (Secrets)",
  pip_audit: "pip-audit (Dependencies)",
  npm_audit: "npm-audit (Dependencies)",
  llm: "LLM Analysis",
};

function fmtUtc(ts) {
  if (!ts) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// ── Shared report helpers ──────────────────────────────────────────────────────

const SEV_COLORS = {
  critical: { fg: "#b91c1c", bg: "#fef2f2", border: "#fca5a5" },
  high:     { fg: "#c2410c", bg: "#fff7ed", border: "#fdba74" },
  medium:   { fg: "#92400e", bg: "#fffbeb", border: "#fcd34d" },
  low:      { fg: "#1d4ed8", bg: "#eff6ff", border: "#93c5fd" },
  info:     { fg: "#374151", bg: "#f9fafb", border: "#d1d5db" },
};

function reportStats(findings) {
  const total = findings.length;
  const sevCounts = Object.fromEntries(SEV_ORDER.map(s => [s, findings.filter(f => f.severity === s).length]));
  const sourceCounts = findings.reduce((a, f) => { a[f.source] = (a[f.source] || 0) + 1; return a; }, {});
  const disp = {
    confirmed:     findings.filter(f => f.disposition === "confirmed").length,
    false_positive:findings.filter(f => f.disposition === "false_positive").length,
    escalated:     findings.filter(f => f.disposition === "escalated").length,
    unreviewed:    findings.filter(f => !f.disposition).length,
  };
  return { total, sevCounts, sourceCounts, disp };
}

// ── Clean Markdown (no emojis, no HTML) ───────────────────────────────────────

function generateMarkdown(sub, findings) {
  const now = fmtUtc(new Date().toISOString());
  const sha = sub.commit_sha || "";
  const { total, sevCounts, sourceCounts, disp } = reportStats(findings);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const srcLabel = s => SOURCE_LABELS[s] || s;
  let md = "";

  md += `# Application Security Report\n\n`;
  md += `Repository: ${sub.repo_full_name}  \n`;
  md += `Commit: ${sha.slice(0, 12)}  \n`;
  md += `Generated: ${now}\n\n`;
  md += `---\n\n`;

  md += `## Submission Details\n\n`;
  md += `| Field | Value |\n|-------|-------|\n`;
  md += `| Repository | \`${sub.repo_full_name}\` |\n`;
  md += `| Commit | \`${sha}\` |\n`;
  if (sub.branch) md += `| Branch | \`${sub.branch}\` |\n`;
  if (sub.submitter) md += `| Submitted by | ${sub.submitter} |\n`;
  if (sub.github_actor && sub.github_actor !== sub.submitter) md += `| GitHub Actor | ${sub.github_actor} |\n`;
  md += `| Submitted | ${fmtUtc(sub.created_at)} |\n`;
  md += `| Review Status | ${sub.status.replace(/_/g, " ").toUpperCase()} |\n\n`;

  md += `---\n\n## Executive Summary\n\n`;

  if (total === 0) {
    md += `No security findings were identified in this submission.\n\n`;
  } else {
    const critHigh = sevCounts.critical + sevCounts.high;
    md += `${total} finding${total !== 1 ? "s" : ""} identified`;
    if (critHigh > 0) md += `, including ${critHigh} critical/high severity issue${critHigh !== 1 ? "s" : ""} requiring prompt attention`;
    md += `.\n\n`;

    md += `### Severity Distribution\n\n`;
    md += `| Severity | Count | Share |\n|----------|-------|-------|\n`;
    for (const sev of SEV_ORDER) {
      if (!sevCounts[sev]) continue;
      md += `| ${cap(sev)} | ${sevCounts[sev]} | ${Math.round(sevCounts[sev] / total * 100)}% |\n`;
    }
    md += `| Total | ${total} | 100% |\n\n`;

    const sevPie = SEV_ORDER.filter(s => sevCounts[s] > 0)
      .map(s => `    "${cap(s)}" : ${sevCounts[s]}`).join("\n");
    md += `\`\`\`mermaid\npie title Findings by Severity\n${sevPie}\n\`\`\`\n\n`;

    const sources = Object.entries(sourceCounts);
    if (sources.length > 1) {
      md += `### Source Distribution\n\n`;
      md += `| Source | Count |\n|--------|-------|\n`;
      for (const [src, count] of sources) md += `| ${srcLabel(src)} | ${count} |\n`;
      const srcPie = sources.map(([s, c]) => `    "${srcLabel(s)}" : ${c}`).join("\n");
      md += `\n\`\`\`mermaid\npie title Findings by Source\n${srcPie}\n\`\`\`\n\n`;
    }

    md += `### Review Status\n\n`;
    md += `| Status | Count |\n|--------|-------|\n`;
    if (disp.confirmed)       md += `| Confirmed | ${disp.confirmed} |\n`;
    if (disp.false_positive)  md += `| False Positive | ${disp.false_positive} |\n`;
    if (disp.escalated)       md += `| Escalated | ${disp.escalated} |\n`;
    if (disp.unreviewed)      md += `| Unreviewed | ${disp.unreviewed} |\n`;
    md += `\n`;
  }

  if (total > 0) {
    md += `---\n\n## Findings\n\n`;
    for (const sev of SEV_ORDER) {
      const group = findings.filter(f => f.severity === sev);
      if (!group.length) continue;
      md += `### ${cap(sev)} (${group.length})\n\n`;
      group.forEach((f, i) => {
        md += `#### ${i + 1}. ${f.title}\n\n`;
        md += `| Field | Value |\n|-------|-------|\n`;
        md += `| Severity | ${cap(f.severity)} |\n`;
        if (f.cwe) md += `| CWE | ${f.cwe} |\n`;
        md += `| Source | ${srcLabel(f.source)} |\n`;
        if (f.file_path) {
          const loc = f.line_start
            ? `${f.file_path}:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ""}`
            : f.file_path;
          md += `| Location | \`${loc}\` |\n`;
        }
        const dLabel = f.disposition
          ? (f.disposition === "false_positive" ? "False Positive" : cap(f.disposition))
            + (f.disposed_by ? ` (by ${f.disposed_by})` : "")
          : "Unreviewed";
        md += `| Disposition | ${dLabel} |\n\n`;
        if (f.description) md += `**Description**\n\n${f.description}\n\n`;
        if (f.code_snippet) {
          const ext = f.file_path?.split(".").pop() || "";
          md += `**Vulnerable Code**\n\n\`\`\`${ext}\n${f.code_snippet}\n\`\`\`\n\n`;
        }
        if (f.remediation) md += `**Remediation**\n\n${f.remediation}\n\n`;
        if (f.llm_reasoning) md += `**LLM Reasoning**\n\n${f.llm_reasoning}\n\n`;
        md += `---\n\n`;
      });
    }
  }

  md += `## Report Metadata\n\n`;
  md += `| Field | Value |\n|-------|-------|\n`;
  md += `| Generated by | Custos Code Review |\n`;
  md += `| Generated at | ${now} |\n`;
  md += `| Submission ID | \`${sub.id}\` |\n`;
  md += `| Total Findings | ${total} |\n`;
  return md;
}

// ── Rich HTML report ───────────────────────────────────────────────────────────

function generateHtmlReport(sub, findings) {
  const now = fmtUtc(new Date().toISOString());
  const sha = sub.commit_sha || "";
  const { total, sevCounts, sourceCounts, disp } = reportStats(findings);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const srcLabel = s => SOURCE_LABELS[s] || s;
  const esc = s => !s ? "" : String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const badge = sev => {
    const c = SEV_COLORS[sev] || SEV_COLORS.info;
    return `<span style="display:inline-block;padding:2px 9px;border-radius:3px;font-size:11px;font-weight:700;letter-spacing:0.05em;background:${c.bg};color:${c.fg};border:1px solid ${c.border};">${cap(sev)}</span>`;
  };

  // Cover severity pills
  const pills = SEV_ORDER.filter(s => sevCounts[s] > 0).map(s => {
    const c = SEV_COLORS[s];
    return `<div style="text-align:center;padding:14px 20px;border-radius:6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);">
      <div style="font-size:32px;font-weight:700;color:#fff;line-height:1;">${sevCounts[s]}</div>
      <div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;color:${c.bg};">${cap(s)}</div>
    </div>`;
  }).join("");

  // CSS bar chart
  const barChart = SEV_ORDER.filter(s => sevCounts[s] > 0).map(s => {
    const c = SEV_COLORS[s];
    const pct = Math.round(sevCounts[s] / total * 100);
    const width = Math.max(pct, 3);
    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
      <div style="width:68px;font-size:12px;color:#57606a;text-align:right;font-weight:500;">${cap(s)}</div>
      <div style="flex:1;background:#e5e7eb;border-radius:3px;height:24px;overflow:hidden;">
        <div style="height:100%;width:${width}%;background:${c.fg};border-radius:3px;display:flex;align-items:center;padding-left:8px;">
          ${pct >= 12 ? `<span style="font-size:11px;color:#fff;font-weight:600;">${pct}%</span>` : ""}
        </div>
      </div>
      <div style="width:28px;font-size:13px;font-weight:700;color:${c.fg};">${sevCounts[s]}</div>
    </div>`;
  }).join("");

  // Source table rows
  const sourceRows = Object.entries(sourceCounts).map(([src, count]) =>
    `<tr><td>${esc(srcLabel(src))}</td><td style="font-weight:600;">${count}</td><td>${Math.round(count / total * 100)}%</td></tr>`
  ).join("");

  // Review status rows
  const dispRows = [
    disp.confirmed      ? `<tr><td>Confirmed</td><td style="color:#15803d;font-weight:600;">${disp.confirmed}</td></tr>` : "",
    disp.false_positive ? `<tr><td>False Positive</td><td style="color:#6b7280;font-weight:600;">${disp.false_positive}</td></tr>` : "",
    disp.escalated      ? `<tr><td>Escalated</td><td style="color:#b91c1c;font-weight:600;">${disp.escalated}</td></tr>` : "",
    disp.unreviewed     ? `<tr><td>Unreviewed</td><td style="color:#92400e;font-weight:600;">${disp.unreviewed}</td></tr>` : "",
  ].join("");

  // Findings sections
  const findingSections = SEV_ORDER.map(sev => {
    const group = findings.filter(f => f.severity === sev);
    if (!group.length) return "";
    const c = SEV_COLORS[sev];

    const cards = group.map((f, i) => {
      const loc = f.file_path
        ? (f.line_start ? `${f.file_path}:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `–${f.line_end}` : ""}` : f.file_path)
        : null;
      const dLabel = f.disposition
        ? (f.disposition === "false_positive" ? "False Positive" : cap(f.disposition))
          + (f.disposed_by ? ` — ${f.disposed_by}` : "")
        : "Unreviewed";
      const dColor = f.disposition === "confirmed" ? "#15803d"
        : f.disposition === "false_positive" ? "#6b7280"
        : f.disposition === "escalated" ? "#b91c1c"
        : "#92400e";

      return `<div style="border:1px solid #e5e7eb;border-left:4px solid ${c.fg};border-radius:0 6px 6px 0;margin-bottom:20px;overflow:hidden;page-break-inside:avoid;">
        <div style="padding:12px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          ${badge(sev)}
          <span style="font-size:11px;color:#9ca3af;font-weight:600;">#${i + 1}</span>
          <span style="font-size:14px;font-weight:600;color:#111827;flex:1;">${esc(f.title)}</span>
          ${f.cwe ? `<span style="font-size:11px;color:#6b7280;font-family:monospace;background:#f3f4f6;padding:2px 7px;border-radius:3px;border:1px solid #e5e7eb;">${esc(f.cwe)}</span>` : ""}
        </div>
        <div style="padding:16px;">
          <table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:14px;">
            <tr>
              <th style="width:120px;padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;text-align:left;font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;">Source</th>
              <td style="padding:6px 10px;border:1px solid #e5e7eb;">${esc(srcLabel(f.source))}</td>
            </tr>
            ${loc ? `<tr><th style="padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;">Location</th><td style="padding:6px 10px;border:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${esc(loc)}</td></tr>` : ""}
            <tr>
              <th style="padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;">Disposition</th>
              <td style="padding:6px 10px;border:1px solid #e5e7eb;color:${dColor};font-weight:600;">${esc(dLabel)}</td>
            </tr>
          </table>
          ${f.description ? `<p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:14px;">${esc(f.description)}</p>` : ""}
          ${f.code_snippet ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;font-weight:600;margin-bottom:6px;">Vulnerable Code</div>
              <pre style="background:#0f172a;color:#e2e8f0;border-radius:6px;padding:14px;overflow-x:auto;font-size:12px;line-height:1.6;margin:0;"><code>${esc(f.code_snippet)}</code></pre>
            </div>` : ""}
          ${f.remediation ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;font-weight:600;margin-bottom:6px;">Remediation</div>
              <p style="font-size:13px;color:#374151;line-height:1.65;margin:0;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;">${esc(f.remediation)}</p>
            </div>` : ""}
          ${f.llm_reasoning ? `
            <details style="margin-top:10px;">
              <summary style="cursor:pointer;font-size:11px;color:#6b7280;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">LLM Reasoning</summary>
              <p style="font-size:12px;color:#6b7280;line-height:1.65;margin-top:8px;padding-left:12px;border-left:2px solid #e5e7eb;">${esc(f.llm_reasoning)}</p>
            </details>` : ""}
        </div>
      </div>`;
    }).join("");

    return `<div style="margin-bottom:32px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid ${c.fg};">
        ${badge(sev)}
        <span style="font-size:13px;color:#6b7280;">${group.length} finding${group.length !== 1 ? "s" : ""}</span>
      </div>
      ${cards}
    </div>`;
  }).join("");

  const tRow = (a, b) => `<tr><th style="width:160px;padding:7px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-size:11px;letter-spacing:0.07em;color:#6b7280;text-transform:uppercase;text-align:left;">${a}</th><td style="padding:7px 12px;border:1px solid #e5e7eb;font-size:13px;">${b}</td></tr>`;

  const statusColor = sub.status === "signed_off" ? "#15803d" : sub.status === "analyzing" ? "#1d4ed8" : "#92400e";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Security Report — ${esc(sub.repo_full_name)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#111827;background:#fff;}
  .page{max-width:880px;margin:0 auto;}
  @media print{
    .no-print{display:none!important;}
    body{font-size:12px;}
    .page{max-width:100%;}
    h2{page-break-before:auto;}
    .finding{page-break-inside:avoid;}
  }
</style>
</head>
<body>
<div class="page">

  <!-- Cover -->
  <div style="background:#111827;color:#fff;padding:44px 48px 40px;">
    <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#9ca3af;margin-bottom:14px;font-weight:600;">Application Security Report</div>
    <div style="font-size:26px;font-weight:700;font-family:monospace;margin-bottom:6px;">${esc(sub.repo_full_name)}</div>
    <div style="font-size:13px;color:#9ca3af;font-family:monospace;">
      ${esc(sha.slice(0, 12))}${sub.branch ? ` &nbsp;·&nbsp; ${esc(sub.branch)}` : ""}
    </div>
    <div style="display:flex;gap:12px;margin-top:28px;flex-wrap:wrap;">${pills}</div>
    <div style="margin-top:24px;font-size:11px;color:#6b7280;">Generated ${now} &nbsp;·&nbsp; Custos Code Review</div>
  </div>

  <div style="padding:36px 48px;">

    <!-- Submission details -->
    <div style="margin-bottom:36px;">
      <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;">Submission Details</h2>
      <table style="border-collapse:collapse;width:100%;">
        ${tRow("Repository", `<code style="font-size:12px;background:#f3f4f6;padding:2px 6px;border-radius:3px;">${esc(sub.repo_full_name)}</code>`)}
        ${tRow("Commit", `<code style="font-size:12px;background:#f3f4f6;padding:2px 6px;border-radius:3px;">${esc(sha)}</code>`)}
        ${sub.branch ? tRow("Branch", `<code style="font-size:12px;background:#f3f4f6;padding:2px 6px;border-radius:3px;">${esc(sub.branch)}</code>`) : ""}
        ${sub.submitter ? tRow("Submitted by", esc(sub.submitter)) : ""}
        ${sub.github_actor && sub.github_actor !== sub.submitter ? tRow("GitHub Actor", esc(sub.github_actor)) : ""}
        ${tRow("Submitted", esc(fmtUtc(sub.created_at)))}
        ${tRow("Review Status", `<span style="font-weight:700;color:${statusColor};">${sub.status.replace(/_/g, " ").toUpperCase()}</span>`)}
      </table>
    </div>

    <!-- Executive summary -->
    <div style="margin-bottom:36px;">
      <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;">Executive Summary</h2>
      ${total === 0
        ? `<p style="color:#6b7280;font-size:13px;">No security findings were identified in this submission.</p>`
        : `
        <p style="font-size:14px;color:#374151;margin-bottom:24px;line-height:1.7;">
          ${total} finding${total !== 1 ? "s" : ""} identified across ${Object.keys(sourceCounts).length} source${Object.keys(sourceCounts).length !== 1 ? "s" : ""}.
          ${sevCounts.critical + sevCounts.high > 0
            ? `<strong style="color:#b91c1c;">${sevCounts.critical + sevCounts.high} critical/high severity issue${sevCounts.critical + sevCounts.high !== 1 ? "s" : ""}</strong> require prompt remediation.`
            : "No critical or high severity issues were identified."}
        </p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-bottom:28px;">
          <div>
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:14px;">Severity Distribution</div>
            ${barChart}
          </div>
          <div>
            <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:14px;">Review Status</div>
            <table style="border-collapse:collapse;width:100%;font-size:13px;">
              <tbody>${dispRows}</tbody>
            </table>
          </div>
        </div>

        ${Object.keys(sourceCounts).length > 1 ? `
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:12px;">Source Distribution</div>
          <table style="border-collapse:collapse;font-size:13px;">
            <thead><tr>
              <th style="padding:6px 14px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;text-align:left;">Source</th>
              <th style="padding:6px 14px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;text-align:left;">Count</th>
              <th style="padding:6px 14px;background:#f9fafb;border:1px solid #e5e7eb;font-size:10px;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;text-align:left;">Share</th>
            </tr></thead>
            <tbody>${sourceRows}</tbody>
          </table>
        </div>` : ""}
      `}
    </div>

    <!-- Findings -->
    ${total > 0 ? `
    <div>
      <h2 style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280;margin-bottom:20px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;">Findings</h2>
      ${findingSections}
    </div>` : ""}

    <!-- Footer -->
    <div style="margin-top:36px;padding-top:20px;border-top:1px solid #e5e7eb;">
      <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#9ca3af;font-weight:600;margin-bottom:10px;">Report Metadata</div>
      <table style="border-collapse:collapse;font-size:12px;color:#6b7280;">
        <tr><td style="padding:3px 16px 3px 0;">Generated by</td><td style="font-weight:600;color:#374151;">Custos Code Review</td></tr>
        <tr><td style="padding:3px 16px 3px 0;">Generated at</td><td style="font-weight:600;color:#374151;">${esc(now)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0;">Submission ID</td><td style="font-family:monospace;font-size:11px;color:#374151;">${esc(sub.id)}</td></tr>
        <tr><td style="padding:3px 16px 3px 0;">Total Findings</td><td style="font-weight:600;color:#374151;">${total}</td></tr>
      </table>
    </div>

  </div>
</div>
</body>
</html>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── ReportModal ───────────────────────────────────────────────────────────────

function ReportModal({ sub, findings, onClose }) {
  const slug = (sub.repo_full_name || "report").replace("/", "-");
  const sha = sub.commit_sha?.slice(0, 8) || "unknown";
  const basename = `custos-report-${slug}-${sha}`;
  const htmlContent = generateHtmlReport(sub, findings);
  const mdContent = generateMarkdown(sub, findings);

  const printPdf = useCallback(() => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(htmlContent);
    iframe.contentDocument.close();
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }, [htmlContent]);

  useEffect(() => {
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.7)", display: "flex",
        alignItems: "stretch", justifyContent: "flex-end",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <style>{`@keyframes slideIn{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}`}</style>
      <div style={{
        width: "min(900px, 96vw)", background: "var(--bg-2)",
        border: "1px solid var(--border)", borderRadius: "var(--radius-lg) 0 0 var(--radius-lg)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
        animation: "slideIn 0.18s ease-out",
      }}>
        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-3)", flexShrink: 0,
        }}>
          <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-2)" }}>
            SECURITY REPORT — {sub.repo_full_name}
          </span>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <ToolbarBtn onClick={() => downloadBlob(mdContent, `${basename}.md`, "text/markdown;charset=utf-8")} label="↓ Markdown" />
            <ToolbarBtn onClick={() => downloadBlob(htmlContent, `${basename}.html`, "text/html;charset=utf-8")} label="↓ HTML" />
            <ToolbarBtn onClick={printPdf} label="↓ PDF" accent />
            <button onClick={onClose} style={{ background:"none",border:"none",color:"var(--text-3)",fontSize:"16px",cursor:"pointer",padding:"2px 8px",lineHeight:1 }}>✕</button>
          </div>
        </div>

        {/* Iframe preview — fully isolated styles */}
        <iframe
          srcDoc={htmlContent}
          style={{ flex: 1, border: "none", width: "100%", background: "#fff" }}
          title="Report preview"
        />
      </div>
    </div>
  );
}

function ToolbarBtn({ onClick, label, accent }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        padding: "4px 10px",
        background: accent ? (hov ? "rgba(240,165,0,0.2)" : "var(--accent-dim)") : (hov ? "var(--bg-2)" : "var(--bg-3)"),
        border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
        borderRadius: "var(--radius)", color: accent ? "var(--accent)" : "var(--text-2)",
        fontSize: "10px", fontWeight: 600, letterSpacing: "0.07em",
        cursor: "pointer", fontFamily: "var(--mono)", transition: "all 0.12s",
      }}
    >
      {label}
    </button>
  );
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtDuration(s) {
  if (s == null) return "—";
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtTokens(n) {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function LlmRunHistory({ submissionId, refreshKey }) {
  const [runs, setRuns] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    getLlmRuns(submissionId).then(setRuns).catch(() => setRuns([]));
  }, [open, submissionId, refreshKey]);

  const statusColor = s => s === "complete" ? "var(--green)" : s === "failed" ? "var(--red)" : "var(--accent)";
  const statusLabel = s => s === "complete" ? "DONE" : s === "failed" ? "FAILED" : "RUNNING";

  return (
    <div style={{ marginTop: "10px" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: "none", border: "none", padding: 0,
          color: "var(--text-3)", fontSize: "11px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: "4px",
          fontFamily: "var(--mono)", letterSpacing: "0.06em",
        }}
      >
        <span style={{ fontSize: "9px" }}>{open ? "▼" : "▶"}</span>
        LLM DETAILS
      </button>

      {open && (
        <div style={{
          marginTop: "10px", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", overflow: "hidden",
        }}>
          {/* Header row */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "80px 1fr 70px 70px 70px 70px 80px",
            padding: "6px 12px", background: "var(--bg-3)",
            borderBottom: "1px solid var(--border)", gap: "8px",
          }}>
            {["TRIGGER", "MODEL", "STATUS", "DURATION", "FINDINGS", "TOKENS IN", "TOKENS OUT"].map(h => (
              <span key={h} style={{ fontSize: "9px", color: "var(--text-3)", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</span>
            ))}
          </div>

          {runs === null && (
            <div style={{ padding: "12px", fontSize: "11px", color: "var(--text-3)" }}>Loading…</div>
          )}
          {runs?.length === 0 && (
            <div style={{ padding: "12px", fontSize: "11px", color: "var(--text-3)" }}>No runs recorded yet.</div>
          )}
          {runs?.map((r, i) => (
            <div key={r.id} style={{
              display: "grid",
              gridTemplateColumns: "80px 1fr 70px 70px 70px 70px 80px",
              padding: "8px 12px", gap: "8px", alignItems: "center",
              borderBottom: i < runs.length - 1 ? "1px solid var(--border)" : "none",
              background: i % 2 === 0 ? "var(--bg-2)" : "var(--bg-3)",
            }}>
              <span style={{
                fontSize: "10px", fontWeight: 600, fontFamily: "var(--mono)",
                color: r.triggered_by === "rerun" ? "var(--accent)" : "var(--text-3)",
                letterSpacing: "0.06em",
              }}>
                {r.triggered_by === "rerun" ? "RE-RUN" : "INITIAL"}
              </span>
              <span style={{ fontSize: "11px", color: "var(--text-2)", fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.model}
              </span>
              <span style={{ fontSize: "10px", fontWeight: 600, color: statusColor(r.status), fontFamily: "var(--mono)" }}>
                {statusLabel(r.status)}
              </span>
              <span style={{ fontSize: "11px", color: "var(--text-2)", fontFamily: "var(--mono)" }}>
                {fmtDuration(r.duration_seconds)}
              </span>
              <span style={{ fontSize: "11px", color: "var(--text-2)", fontFamily: "var(--mono)" }}>
                {r.findings_count ?? "—"}
              </span>
              <span style={{ fontSize: "11px", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                {fmtTokens(r.prompt_tokens)}
              </span>
              <span style={{ fontSize: "11px", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                {fmtTokens(r.completion_tokens)}
              </span>
            </div>
          ))}
          {runs?.some(r => r.error) && (
            <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", background: "var(--red-dim)" }}>
              {runs.filter(r => r.error).map(r => (
                <div key={r.id} style={{ fontSize: "11px", color: "var(--red)" }}>
                  {r.triggered_by === "rerun" ? "Re-run" : "Initial"} error: {r.error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LlmRerunPanel({ submissionId, onComplete }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => {
    getLlmStatus(submissionId).then(s => {
      if (s.status === "running" || s.status === "queued") {
        setStatus(s);
        startPolling();
      }
    }).catch(() => {});
    return stopPolling;
  }, [submissionId]);

  const startPolling = () => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const s = await getLlmStatus(submissionId);
        setStatus(s);
        if (s.status === "complete") {
          stopPolling();
          setHistoryKey(k => k + 1);
          onComplete?.();
        } else if (s.status === "failed") {
          stopPolling();
          setHistoryKey(k => k + 1);
          setError("LLM re-run failed");
        }
      } catch { stopPolling(); }
    }, 2000);
  };

  const handleRerun = async () => {
    setError(null);
    setStatus({ status: "queued", elapsed: 0, estimated: 90, progress: 0 });
    try {
      await rerunLlm(submissionId);
      startPolling();
    } catch (e) {
      setStatus(null);
      setError(e.response?.data?.detail || "Failed to start re-run");
    }
  };

  const isActive = status?.status === "running" || status?.status === "queued";
  const pct = Math.round((status?.progress || 0) * 100);
  const remaining = status?.status === "running" && status.estimated > 0
    ? Math.max(0, Math.round(status.estimated - status.elapsed))
    : null;

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: "var(--radius-lg)",
      overflow: "hidden", background: "var(--bg-2)", marginBottom: "16px",
    }}>
      <div style={{
        padding: "10px 16px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-3)", display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-2)" }}>
          LLM ANALYSIS
        </span>
        {status?.status === "complete" && (
          <span style={{ fontSize: "10px", color: "var(--green)", fontWeight: 600 }}>✓ COMPLETE</span>
        )}
      </div>
      <div style={{ padding: "14px 16px" }}>
        {isActive ? (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <span style={{ fontSize: "11px", color: "var(--text-2)" }}>
                {status.status === "queued" ? "Queued…" : "Running…"}
              </span>
              <span style={{ fontSize: "11px", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                {status.status === "running"
                  ? `${pct}%${remaining !== null ? ` · ~${remaining}s remaining` : ""}`
                  : "waiting for worker"}
              </span>
            </div>
            <div style={{ height: "4px", background: "var(--border)", borderRadius: "2px", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: status.status === "queued" ? "6%" : `${pct}%`,
                background: "var(--accent)", borderRadius: "2px",
                transition: "width 1.8s ease-out",
                animation: status.status === "queued" ? "shimmer 1.4s ease-in-out infinite" : "none",
              }} />
            </div>
            <style>{`@keyframes shimmer{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
            {status.status === "running" && (
              <div style={{ marginTop: "6px", fontSize: "10px", color: "var(--text-3)" }}>
                {status.elapsed > 0 ? `${Math.round(status.elapsed)}s elapsed` : ""}
                {status.estimated > 0 ? ` · est. ${Math.round(status.estimated)}s total` : ""}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              onClick={handleRerun}
              style={{
                padding: "7px 14px",
                background: "var(--accent-dim)", border: "1px solid var(--accent)",
                borderRadius: "var(--radius)", color: "var(--accent)",
                fontSize: "11px", fontWeight: 600, letterSpacing: "0.08em",
                cursor: "pointer", fontFamily: "var(--mono)", transition: "all 0.15s",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(240,165,0,0.2)"}
              onMouseLeave={e => e.currentTarget.style.background = "var(--accent-dim)"}
            >
              ↺ RE-RUN LLM
            </button>
            <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
              Re-clones at the same SHA · uses stored SAST findings as context · only LLM findings are replaced
            </span>
          </div>
        )}
        {status?.status === "complete" && (
          <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--green)" }}>
            ✓ Findings updated — scroll down to review new LLM results
          </div>
        )}
        {error && (
          <div style={{ marginTop: "8px", padding: "8px 12px", background: "var(--red-dim)", border: "1px solid #f8514933", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "12px" }}>
            {error}
          </div>
        )}
        <LlmRunHistory submissionId={submissionId} refreshKey={historyKey} />
      </div>
    </div>
  );
}

export default function Submission() {
  const { id } = useParams();
  const [sub, setSub] = useState(null);
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showReport, setShowReport] = useState(false);

  useEffect(() => {
    Promise.all([getSubmission(id), getSubmissionFindings(id)])
      .then(([s, f]) => { setSub(s); setFindings(f); })
      .catch(e => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState msg={error} />;

  const grouped = SEV_ORDER.reduce((acc, sev) => {
    const items = findings.filter(f => f.severity === sev);
    if (items.length > 0) acc[sev] = items;
    return acc;
  }, {});

  return (
    <div style={{ padding: "24px", maxWidth: "1100px", margin: "0 auto" }}>
      {/* Breadcrumb */}
      <div style={{ marginBottom: "20px", display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--text-3)" }}>
        <Link to="/" style={{ color: "var(--text-3)", textDecoration: "none" }}>Queue</Link>
        <span>›</span>
        <span style={{ color: "var(--text-2)" }}>{sub.repo_full_name}</span>
      </div>

      {/* Header */}
      <div style={{
        background: "var(--bg-2)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", padding: "20px 24px",
        marginBottom: "24px",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: "18px", fontWeight: 600, color: "var(--text)", fontFamily: "var(--sans)", letterSpacing: "-0.02em", marginBottom: "6px" }}>
              {sub.repo_full_name}
            </h1>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <MetaItem label="commit" value={sub.commit_sha?.slice(0, 12)} mono />
              {sub.branch && <MetaItem label="branch" value={sub.branch} mono color="var(--blue)" />}
              {sub.submitter && <MetaItem label="submitter" value={sub.submitter} />}
              {sub.github_actor && <MetaItem label="actor" value={sub.github_actor} />}
              <MetaItem label="submitted" value={fmtDate(sub.created_at)} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={() => setShowReport(true)}
              title="Generate security report"
              style={{
                padding: "5px 12px",
                background: "var(--bg-3)", border: "1px solid var(--border)",
                borderRadius: "var(--radius)", color: "var(--text-2)",
                fontSize: "11px", fontWeight: 600, letterSpacing: "0.06em",
                cursor: "pointer", fontFamily: "var(--mono)", transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: "5px",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-2)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-2)"; }}
            >
              ↓ REPORT
            </button>
            <StatusBadge status={sub.status} />
          </div>
        </div>

        {/* Finding counts by severity */}
        <div style={{ display: "flex", gap: "8px", marginTop: "16px", paddingTop: "16px", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
          {SEV_ORDER.map(sev => {
            const count = findings.filter(f => f.severity === sev).length;
            if (count === 0) return null;
            return (
              <div key={sev} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <SeverityBadge severity={sev} />
                <span style={{ fontSize: "12px", color: "var(--text-2)", fontWeight: 500 }}>{count}</span>
              </div>
            );
          })}
          {findings.length === 0 && (
            <span style={{ fontSize: "12px", color: "var(--text-3)" }}>No findings</span>
          )}
        </div>
      </div>

      {/* LLM re-run panel — full width, above findings */}
      <LlmRerunPanel
        submissionId={id}
        onComplete={async () => {
          const [updatedSub, updatedFindings] = await Promise.all([
            getSubmission(id),
            getSubmissionFindings(id),
          ]);
          setSub(updatedSub);
          setFindings(updatedFindings);
        }}
      />

      {/* Two-column: findings + sign-off panel */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "20px", alignItems: "start" }}>
        {/* Findings */}
        <div>
          {findings.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--text-3)", fontSize: "12px", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}>
              No findings for this submission.
            </div>
          ) : (
            Object.entries(grouped).map(([sev, items]) => (
              <div key={sev} style={{ marginBottom: "20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                  <SeverityBadge severity={sev} full />
                  <span style={{ fontSize: "11px", color: "var(--text-3)" }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {items.map(f => (
                    <FindingCard key={f.id} finding={f} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Right column */}
        <div style={{ position: "sticky", top: "68px" }}>
          <SignOffPanel
            submission={sub}
            findings={findings}
            onSignOff={(updated) => setSub(updated)}
          />
        </div>
      </div>

      {showReport && (
        <ReportModal
          sub={sub}
          findings={findings}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  );
}

function MetaItem({ label, value, mono, color }) {
  if (!value) return null;
  return (
    <span style={{ fontSize: "11px" }}>
      <span style={{ color: "var(--text-3)" }}>{label}: </span>
      <span style={{ color: color || "var(--text-2)", fontFamily: mono ? "var(--mono)" : undefined }}>
        {value}
      </span>
    </span>
  );
}

function LoadingState() {
  return (
    <div style={{ padding: "60px", textAlign: "center", color: "var(--text-3)", fontSize: "12px" }}>
      Loading submission...
    </div>
  );
}

function ErrorState({ msg }) {
  return (
    <div style={{ padding: "24px" }}>
      <div style={{ padding: "16px", background: "var(--red-dim)", border: "1px solid #f8514933", borderRadius: "var(--radius-lg)", color: "var(--red)" }}>
        {msg}
      </div>
    </div>
  );
}
