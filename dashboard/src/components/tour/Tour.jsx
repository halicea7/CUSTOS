// Welcome tour: a spotlight that walks across pages, highlighting one element at
// a time with a short explanation. Plays once per user (stored on the account);
// Settings → Account replays it.
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../../App.jsx";
import api from "../../api/client.js";
import { listSubmissions } from "../../api/submissions.js";
import { buildSteps } from "./steps.jsx";

const TourCtx = createContext({ start: () => {} });
export const useTour = () => useContext(TourCtx);

const PAD = 8;          // spotlight padding around the target
const CARD_W = 360;
const GAP = 14;         // between the spotlight and the card
const FIND_FOR = 4000;  // ms to wait for a target after navigating

// A finished scan with findings makes the best example run page.
async function exampleRun() {
  try {
    const { submissions = [] } = await listSubmissions(null, null, 50);
    const done = submissions.filter((s) => s.status === "needs_review" || s.status === "signed_off");
    const total = (s) => Object.values(s.finding_counts || {}).reduce((a, n) => a + n, 0);
    return (done.find((s) => total(s) > 0) || done[0])?.id || null;
  } catch {
    return null;
  }
}

function place(rect, pref, cardH) {
  const vw = window.innerWidth, vh = window.innerHeight, m = 12;
  const w = Math.min(CARD_W, vw - 2 * m);
  if (!rect) return { left: (vw - w) / 2, top: Math.max(m, (vh - cardH) / 2), w };
  const fits = {
    right: rect.right + GAP + w < vw - m,
    left: rect.left - GAP - w > m,
    bottom: rect.bottom + GAP + cardH < vh - m,
    top: rect.top - GAP - cardH > m,
  };
  const side = [pref, "bottom", "right", "top", "left"].find((s) => fits[s]) || "inside";
  const clampX = (x) => Math.min(Math.max(m, x), vw - w - m);
  const clampY = (y) => Math.min(Math.max(m, y), vh - cardH - m);
  if (side === "right") return { left: rect.right + GAP, top: clampY(rect.top), w };
  if (side === "left") return { left: rect.left - GAP - w, top: clampY(rect.top), w };
  if (side === "bottom") return { left: clampX(rect.left), top: rect.bottom + GAP, w };
  if (side === "top") return { left: clampX(rect.left), top: rect.top - GAP - cardH, w };
  return { left: clampX(rect.right - w - m), top: clampY(rect.bottom - cardH - m), w }; // huge target
}

function Overlay({ steps, index, setIndex, onClose }) {
  const step = steps[index];
  const navigate = useNavigate();
  const location = useLocation();
  const [el, setEl] = useState(null);
  const [rect, setRect] = useState(null);
  const [cardH, setCardH] = useState(200);
  const card = useRef(null);
  const last = index === steps.length - 1;

  // Go to the step's page, then wait for its target to render.
  useEffect(() => {
    setEl(null); setRect(null);
    if (step.path && location.pathname + location.search !== step.path) navigate(step.path);
    if (!step.target) return undefined;
    const until = Date.now() + FIND_FOR;
    let timer;
    const look = () => {
      const found = document.querySelector(step.target);
      const r = found?.getBoundingClientRect();
      if (found && r.width > 0 && r.height > 0) {
        found.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        setEl(found);
      } else if (Date.now() < until) timer = setTimeout(look, 100);
    };
    look();
    return () => clearTimeout(timer);
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the target while it scrolls, animates or the window resizes.
  useEffect(() => {
    if (!el) return undefined;
    let raf;
    const tick = () => {
      const r = el.getBoundingClientRect();
      setRect((p) => (p && p.top === r.top && p.left === r.left && p.width === r.width && p.height === r.height ? p
        : { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom }));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [el]);

  const found = rect !== null;
  useLayoutEffect(() => { if (card.current) setCardH(card.current.offsetHeight); }, [index, found]);

  // Own the keyboard while the tour is open (pages have their own shortcuts).
  useEffect(() => {
    const onKey = (e) => {
      e.stopImmediatePropagation();
      if (e.key === "Escape") { e.preventDefault(); onClose(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); last ? onClose(true) : setIndex(index + 1); }
      else if (e.key === "ArrowLeft" && index > 0) { e.preventDefault(); setIndex(index - 1); }
      else if (e.key !== "Tab") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, last, onClose, setIndex]);

  useEffect(() => { card.current?.querySelector("button.primary")?.focus({ preventScroll: true }); }, [index]);

  const waiting = step.target && !rect;
  // A frame queued for the previous target can land after the reset; only trust a rect while its element is current.
  const hole = el && rect && { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD };
  const pos = place(hole && { ...hole, right: hole.left + hole.width, bottom: hole.top + hole.height }, step.place || "right", cardH);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      <div className="tour-block" />
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div ref={card} className={`tour-card ${waiting ? "waiting" : ""}`} key={index}
        style={{ left: pos.left, top: pos.top, width: pos.w }}>
        <div className="tour-step">{index + 1} of {steps.length}</div>
        <h3 id="tour-title">{step.title}</h3>
        <div id="tour-body" className="tour-body">{step.body}</div>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((s, i) => <span key={s.id} className={i === index ? "on" : i < index ? "done" : ""} />)}
        </div>
        <div className="tour-actions">
          <button className="link" onClick={() => onClose(false)}>Skip tour</button>
          <span style={{ flex: 1 }} />
          {index > 0 && <button className="btn sm" onClick={() => setIndex(index - 1)}>Back</button>}
          <button className="btn primary sm" onClick={() => (last ? onClose(true) : setIndex(index + 1))}>
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TourProvider({ children }) {
  const { user, updateUser } = useAuth();
  const navigate = useNavigate();
  const [steps, setSteps] = useState(null);
  const [index, setIndex] = useState(0);
  const autoStarted = useRef(false);

  const start = useCallback(async () => {
    const runId = await exampleRun();
    setSteps(buildSteps({ role: user?.role, name: user?.username, runId }));
    setIndex(0);
  }, [user]);

  // First sign-in: play it once, after the queue has had a moment to render.
  useEffect(() => {
    if (!user || user.tour_completed_at || autoStarted.current) return undefined;
    // Mark it only when the timer fires: a cancelled timer (StrictMode, re-render) must not count.
    const t = setTimeout(() => { autoStarted.current = true; start(); }, 900);
    return () => clearTimeout(t);
  }, [user, start]);

  const close = useCallback(async (finished) => {
    setSteps(null);
    if (finished) navigate("/");
    try {
      const { data } = await api.put("/auth/me/tour", { done: true });
      updateUser(data);
    } catch { /* worst case it plays again next sign-in */ }
  }, [navigate, updateUser]);

  return (
    <TourCtx.Provider value={{ start }}>
      {children}
      {steps && <Overlay steps={steps} index={index} setIndex={setIndex} onClose={close} />}
    </TourCtx.Provider>
  );
}
