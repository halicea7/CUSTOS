// Minimal Markdown for finding text (descriptions, LLM analysis, fixes).
// The text comes from scanned repos and the LLM, so this builds React elements
// only: no HTML is ever injected, and links render as plain text.
import React from "react";

const FENCE = /^```\s*([\w+-]*)\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(?:\d+[.)]|\(\d+\))\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

// "(1) foo. (2) bar." or "1) foo 2) bar" written as one paragraph → separate items.
function splitEnumeration(text) {
  const marks = [...text.matchAll(/(?:^|\s)\((\d{1,2})\)\s+/g)];
  if (marks.length < 2 || marks[0].index > 120 || Number(marks[0][1]) !== 1) return null;
  if (!marks.every((m, i) => Number(m[1]) === i + 1)) return null;
  const lead = text.slice(0, marks[0].index).trim();
  const items = marks.map((m, i) => text.slice(m.index + m[0].length, marks[i + 1]?.index ?? text.length).trim());
  return { lead, items };
}

// Inline: `code`, **bold**, and [label](url) shown as "label".
function inline(text, key = "") {
  const out = [];
  const re = /(`+)([\s\S]*?)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\([^)\s]+\)/g;
  let last = 0, m, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(<code key={`${key}c${n++}`} className="md-code">{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<b key={`${key}b${n++}`}>{m[3]}</b>);
    else out.push(m[4]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Expand a line like "(1) a (2) b" or "Fix: (1) a (2) b" into separate numbered lines.
function expandEnumerations(lines) {
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const en = !inFence && splitEnumeration(line);
    if (en) {
      if (en.lead) out.push(en.lead, "");
      en.items.forEach((it, i) => out.push(`${i + 1}. ${it}`));
      out.push("");
    } else out.push(line);
  }
  return out;
}

function blocks(src) {
  const lines = expandEnumerations(String(src).replace(/\r\n?/g, "\n").split("\n"));
  const out = [];
  let para = [], list = null;
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    para = [];
    const en = splitEnumeration(text);
    if (en) {
      if (en.lead) out.push({ type: "p", text: en.lead });
      out.push({ type: "ol", items: en.items });
    } else if (text) out.push({ type: "p", text });
  };
  const flushList = () => { if (list) { out.push(list); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flushPara(); flushList();
      const code = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      out.push({ type: "pre", lang: fence[1], text: code.join("\n") });
      continue;
    }
    const bullet = line.match(BULLET), num = line.match(NUMBERED), head = line.match(HEADING);
    if (bullet || num) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((bullet || num)[1]);
    } else if (head) {
      flushPara(); flushList();
      out.push({ type: "h", text: head[1] });
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;   // continuation of a list item
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out;
}

export default function Markdown({ text, className = "" }) {
  if (!text) return null;
  return (
    <div className={`md ${className}`}>
      {blocks(text).map((b, i) => {
        if (b.type === "pre") return <pre key={i} className="md-pre" data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
        if (b.type === "h") return <p key={i} className="md-h">{inline(b.text, i)}</p>;
        if (b.type === "p") return <p key={i}>{inline(b.text, i)}</p>;
        const List = b.type;
        return <List key={i}>{b.items.map((it, j) => <li key={j}>{inline(it, `${i}-${j}`)}</li>)}</List>;
      })}
    </div>
  );
}
