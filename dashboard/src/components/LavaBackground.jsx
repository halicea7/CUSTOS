// Login backdrop: a dot matrix lit by slow, merging "lava lamp" blobs.
// Dots never move or resize; only their brightness and tint follow the blobs.
import React, { useEffect, useRef } from "react";

const STEP = 11;       // grid spacing, px
const DOT = 1.9;       // dot radius, px
const LEVELS = 10;     // brightness buckets: one fill per bucket per frame
const PURPLE = [124, 92, 255];
const PINK = [232, 121, 249];

// Each blob wanders on its own slow, out-of-phase path (positions are screen fractions).
const BLOBS = Array.from({ length: 7 }, (_, i) => ({
  r: 0.11 + (0.05 * ((i * 37) % 5)) / 4,
  ax: 0.32 + 0.1 * (i % 3), ay: 0.34 + 0.08 * ((i + 1) % 3),
  fx: 0.000045 + 0.00002 * i, fy: 0.00004 + 0.000017 * ((i * 3) % 7),
  px: i * 1.7, py: i * 2.3,
}));

const smooth = (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
const mix = (k) => PURPLE.map((v, i) => Math.round(v + (PINK[i] - v) * k));

function draw(ctx, w, h, t, light) {
  const m = Math.min(w, h);
  const blobs = BLOBS.map((b) => ({
    x: w * (0.5 + b.ax * Math.sin(t * b.fx + b.px)),
    y: h * (0.5 + b.ay * Math.sin(t * b.fy + b.py)),
    r2: (b.r * m) ** 2,
  }));
  const buckets = Array.from({ length: LEVELS }, () => []);
  for (let y = STEP / 2; y < h + STEP; y += STEP) {
    for (let x = STEP / 2; x < w + STEP; x += STEP) {
      let f = 0;
      for (const b of blobs) { const dx = x - b.x, dy = y - b.y; f += b.r2 / (dx * dx + dy * dy + 1); }
      buckets[Math.round(smooth(0.35, 1.7, f) * (LEVELS - 1))].push(x, y);
    }
  }
  ctx.clearRect(0, 0, w, h);
  buckets.forEach((pts, i) => {
    if (!pts.length) return;
    const k = i / (LEVELS - 1);
    const [r, g, b] = mix(Math.max(0, k - 0.35) / 0.65);
    ctx.fillStyle = `rgba(${r},${g},${b},${(light ? 0.1 : 0.07) + k * (light ? 0.55 : 0.75)})`;
    ctx.beginPath();
    for (let j = 0; j < pts.length; j += 2) { ctx.moveTo(pts[j] + DOT, pts[j + 1]); ctx.arc(pts[j], pts[j + 1], DOT, 0, 6.2832); }
    ctx.fill();
  });
}

export default function LavaBackground({ light }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv.getContext("2d");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0;
    const T0 = 40000; // start mid-wander so the first frame isn't a cluster in the centre
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (still) draw(ctx, w, h, T0, light);
    };
    const frame = (t) => { draw(ctx, w, h, t + T0, light); raf = requestAnimationFrame(frame); };
    const start = () => { cancelAnimationFrame(raf); if (!still && !document.hidden) raf = requestAnimationFrame(frame); };
    resize(); start();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", start);
    };
  }, [light]);
  return <canvas ref={ref} className="lava" aria-hidden="true" />;
}
