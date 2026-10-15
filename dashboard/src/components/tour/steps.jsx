// What the welcome tour shows. Targets are [data-tour] attributes on the pages;
// a step whose target doesn't render (e.g. no repos yet) shows centred instead.
import React from "react";

const T = (id) => `[data-tour="${id}"]`;
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function buildSteps({ role, name, runId }) {
  const admin = role === "admin";
  const run = runId ? `/submissions/${runId}` : null;
  const steps = [
    {
      id: "welcome", title: `Welcome to Custos${name ? `, ${name}` : ""}`,
      body: <>
        <p>Custos scans your repositories with static analysis tools and an AI reviewer, and you decide what each finding means.</p>
        <p>This takes about a minute. Use <span className="kbd">→</span> and <span className="kbd">←</span> to move; you can replay it any time from <b>Settings → Account</b>.</p>
      </>,
    },
    {
      id: "nav", path: "/", target: T("nav"), place: "right", title: "Getting around",
      body: <p><b>Queue</b> lists every scan and what needs review. <b>Repos</b> is where you connect and look after your repositories.
        {admin && <> As an admin you also get <b>Health</b>, <b>Groups</b> and the full <b>Settings</b>.</>}</p>,
    },
    {
      id: "search", path: "/", target: T("search"), place: "right", title: "Jump anywhere",
      body: <p>Press <span className="kbd">{mac ? "⌘K" : "Ctrl K"}</span> to search runs, repositories and pages from anywhere.</p>,
    },
    {
      id: "summary", path: "/", target: T("queue-summary"), place: "bottom", title: "Your queue at a glance",
      body: <p>How many runs are waiting for review, open critical and high findings, and what&rsquo;s scanning now. Click a tile to filter the list below.</p>,
    },
    {
      id: "queue", path: "/", target: T("queue-table"), place: "top", title: "Every scan, by repository",
      body: <p>Each row is a repository&rsquo;s latest scan with its findings by severity and a trend. Click a repository to open the run; repositories with several runs expand to show their history.</p>,
    },
    {
      id: "add-repo", path: "/repos", target: T("add-repo"), place: "bottom", title: "Add your repositories",
      body: <>
        <p>Enter the repository (<span className="mono">owner/name</span>) and a GitHub token that can read it: a fine-grained token with <b>Contents</b> and <b>Pull requests</b> read access is enough.</p>
        <p>Custos checks the token before saving, and you can share the repo with your group so teammates see its scans.</p>
      </>,
    },
    {
      id: "repo-care", path: "/repos", target: T("repo-table"), place: "top", title: "Look after them",
      body: <ul>
        <li><b>Check for updates</b> scans new commits and pull requests now; otherwise Custos checks on a schedule.</li>
        <li>The <b>token</b> column warns when a token is close to expiring. Replace it before then or scans stop.</li>
        <li>The switch pauses scanning; <b>+ group</b> shares the repo, <b>×</b> stops sharing.</li>
        <li>Crit, High and Trend show how the latest scan compares with earlier ones.</li>
      </ul>,
    },
  ];

  if (run) {
    steps.push(
      {
        id: "run-changes", path: run, target: T("run-changes"), place: "bottom", title: "A finished scan",
        body: <p>This is a real run from your queue. The tiles show what&rsquo;s <b>new</b> since the previous scan, what got <b>fixed</b>, and what&rsquo;s unchanged. Click <b>New</b> to see only the new findings.</p>,
      },
      {
        id: "run-findings", path: run, target: T("run-findings"), place: "top", title: "Triage the findings",
        body: <>
          <p>Open a finding to see the code, why it was flagged and how to fix it. Mark it <b>False positive</b>, <b>Confirm</b> it, or <b>Escalate</b> it to a senior reviewer.</p>
          <p>Shortcuts: <span className="kbd">J</span>/<span className="kbd">K</span> to move, <span className="kbd">F</span> <span className="kbd">C</span> <span className="kbd">E</span> to decide, <span className="kbd">X</span> to select several and decide them together.</p>
        </>,
      },
      {
        id: "run-report", path: run, target: T("run-report"), place: "bottom", title: "Export the report",
        body: <p><b>Report</b> opens the full security report for this commit: every finding, its severity and your decisions. Download it as <b>Markdown</b> for a ticket, wiki or pull request, as <b>HTML</b>, or print it to <b>PDF</b>.</p>,
      },
      {
        id: "run-remediations", path: run, target: T("run-remediations"), place: "bottom", title: "Let an AI agent check the findings",
        body: <>
          <p><b>REMEDIATIONS.md</b> gives an AI coding agent (Claude Code, Copilot, Cursor…) each finding with its file, line and a suggested fix. The agent checks whether each one is valid first, proposes small fixes for the valid ones, and leaves the decisions to you.</p>
          <p>Triage first: findings you mark <b>false positive</b> are left out. Put the file in the repo and ask the agent to work through it, then let Custos rescan.</p>
        </>,
      },
      {
        id: "run-signoff", path: run, target: T("run-signoff"), place: "left", title: admin ? "Sign off and approvals" : "Sign off",
        body: admin
          ? <p>Analysts&rsquo; sign-offs land here as <b>Awaiting approval</b>: read their comment, then <b>Approve</b> it or <b>Send back</b> with a reason. You can also sign off a run yourself in one step.</p>
          : <p>When every critical and high finding (and every step of a serious <b>attack chain</b>) has a decision, sign off with a comment. An admin then approves it, or sends it back with a reason you&rsquo;ll see here.</p>,
      },
    );
  } else {
    steps.push({
      id: "run-later", title: "When a scan finishes",
      body: <>
        <p>Open it from the queue to triage its findings: <b>False positive</b>, <b>Confirm</b> or <b>Escalate</b> each one, then <b>Sign off</b>.</p>
        <p>Two exports live there: <b>Report</b> (the full security report as Markdown, HTML or PDF) and <b>REMEDIATIONS.md</b>, suggestions an AI coding agent can check and propose fixes for. Mark false positives first; they&rsquo;re left out of it.</p>
      </>,
    });
  }

  if (admin) {
    steps.push(
      {
        id: "health", path: "/health", target: T("health-services"), place: "bottom", title: "Health",
        body: <p>Whether the database, worker, LLM and SentinelOne are reachable, checked every 30 seconds. <b>Run self-check</b> scans Custos&rsquo;s own code with the same tools.</p>,
      },
      {
        id: "groups", path: "/groups", target: T("groups-create"), place: "bottom", title: "Groups",
        body: <p>Analysts see the repositories they added plus any shared with their groups. Create a group, add members, then share repositories with it from the Repos page.</p>,
      },
      {
        id: "users", path: "/settings?tab=users", target: T("users"), place: "right", title: "People",
        body: <p>Create accounts and switch people between <b>Analyst</b> and <b>Admin</b>. New users get this tour the first time they sign in.</p>,
      },
      {
        id: "analysis", path: "/settings?tab=config", target: T("ai-review"), place: "right", title: "The AI reviewer",
        body: <p>Choose where the AI review runs: a local <b>Ollama</b> model, any <b>Responses API</b> server, or <b>Amazon Bedrock</b> with its data-retention controls. Scanning limits and SentinelOne live here too.</p>,
      },
    );
  }

  steps.push(
    {
      id: "account", path: "/settings?tab=account", target: T("tour-replay"), place: "bottom", title: "Your account",
      body: <p>Change your password here, and replay this tour whenever you like.</p>,
    },
    {
      id: "done", title: "You're all set",
      body: <p>{admin ? "Add a repository or two, invite your team, and you're ready." : "Add your first repository and Custos takes it from there."} Findings land in the queue as soon as a scan finishes.</p>,
    },
  );
  return steps;
}
