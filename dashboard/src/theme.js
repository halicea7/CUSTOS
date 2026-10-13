// Muted tones: readable on a full queue without a wall of neon.
const sevLight = {
  critical: { fg: "#c8372d", solid: "#d9473c", bg: "#fbebea", label: "Critical", short: "CRIT" },
  high:     { fg: "#b9601f", solid: "#d97a33", bg: "#fbf0e6", label: "High",     short: "HIGH" },
  medium:   { fg: "#9a6c12", solid: "#c99a2e", bg: "#fbf4e1", label: "Medium",   short: "MED"  },
  low:      { fg: "#2f6fc4", solid: "#3d7fd6", bg: "#eaf1fb", label: "Low",      short: "LOW"  },
  info:     { fg: "#5a6473", solid: "#8a93a1", bg: "#eef0f3", label: "Info",     short: "INFO" },
};
const sevDark = {
  critical: { fg: "#f0716a", solid: "#e5625a", bg: "rgba(240,113,106,0.12)", label: "Critical", short: "CRIT" },
  high:     { fg: "#e89a5c", solid: "#dc8a4a", bg: "rgba(232,154,92,0.11)",  label: "High",     short: "HIGH" },
  medium:   { fg: "#d9b45a", solid: "#c9a24a", bg: "rgba(217,180,90,0.10)",  label: "Medium",   short: "MED"  },
  low:      { fg: "#6ea3e6", solid: "#5b93da", bg: "rgba(110,163,230,0.10)", label: "Low",      short: "LOW"  },
  info:     { fg: "#9aa4b2", solid: "#6e7a8a", bg: "rgba(139,148,158,0.12)", label: "Info",     short: "INFO" },
};

export const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

export const STATUS_META = {
  pending:    { label: "Pending",    dark: "#8a93a1", light: "#8a93a1" },
  analyzing:  { label: "Scanning",   dark: "#9b7bff", light: "#6d4aff" },
  needs_review: { label: "Needs review", dark: "#d9b45a", light: "#9a6c12" },
  awaiting_approval: { label: "Awaiting approval", dark: "#7fb3e8", light: "#2563a8" },
  signed_off: { label: "Signed off", dark: "#5cbf7a", light: "#22874a" },
  error:      { label: "Error",      dark: "#f0716a", light: "#c8372d" },
};

export const HEALTH_META = {
  healthy: { label: "Healthy", light: "#1f9d4d", dark: "#3fb950" },
  warning: { label: "Warning", light: "#c2570a", dark: "#fb923c" },
  urgent:  { label: "Urgent",  light: "#c2241a", dark: "#ff6b63" },
};

export const CAT_COLORS = {
  light: { sast: "#2f7ee0", secrets: "#dc2626", dependencies: "#d29922", config: "#ea7317", llm: "#7c3aed" },
  dark:  { sast: "#58a6ff", secrets: "#f85149", dependencies: "#e3b341", config: "#f0883e", llm: "#bc8cff" },
};

const light = {
  bg: "#f5f5f8", surface: "#ffffff", raised: "#f9f9fb", raised2: "#efeef4",
  border: "#e4e3ea", border2: "#d4d2dd",
  text: "#1c1828", text2: "#544d68", text3: "#8c85a1",
  accent: "#6d4aff", accentBg: "rgba(109,74,255,0.09)", accentLine: "rgba(109,74,255,0.35)",
  accentText: "#ffffff", link: "#6d4aff",
  grad: "linear-gradient(135deg,#6d4aff 0%,#8b5cf6 55%,#a855f7 100%)",
  glow: "radial-gradient(1100px 320px at 10% -12%, rgba(109,74,255,0.05), transparent 60%)",
  sidebar: "#ffffff",
  shadow: "0 1px 2px rgba(40,20,90,0.06)", shadowHi: "0 18px 44px rgba(40,20,90,0.14)",
};
const dark = {
  bg: "#0f0e14", surface: "#15141b", raised: "#1a1921", raised2: "#211f29",
  border: "#26242e", border2: "#35323e",
  text: "#e6e4ec", text2: "#a7a3b3", text3: "#6f6b7c",
  accent: "#9b7bff", accentBg: "rgba(155,123,255,0.15)", accentLine: "rgba(155,123,255,0.45)",
  accentText: "#ffffff", link: "#a891ff",
  grad: "linear-gradient(135deg,#7c5cff 0%,#a855f7 55%,#c084fc 100%)",
  glow: "radial-gradient(1100px 320px at 10% -12%, rgba(124,92,255,0.09), transparent 60%)",
  sidebar: "linear-gradient(180deg,#17151f 0%,#15141b 40%)",
  shadow: "0 1px 2px rgba(0,0,0,0.35)", shadowHi: "0 18px 44px rgba(0,0,0,0.5)",
};

export function makeTheme(mode) {
  const isLight = mode === "light";
  return {
    mode,
    radius: 10, radiusLg: 14,
    sev: isLight ? sevLight : sevDark,
    status: STATUS_META,
    health: HEALTH_META,
    cat: isLight ? CAT_COLORS.light : CAT_COLORS.dark,
    fontUi: '"Space Grotesk", sans-serif',
    fontDisplay: '"Space Grotesk", sans-serif',
    fontMono: '"JetBrains Mono", monospace',
    c: isLight ? light : dark,
  };
}

export function applyCssVars(theme) {
  const r = document.documentElement.style;
  const c = theme.c;
  const isLight = theme.mode === "light";
  r.setProperty("--bg",          c.bg);
  r.setProperty("--bg-2",        c.surface);
  r.setProperty("--bg-3",        c.raised);
  r.setProperty("--bg-4",        c.raised2);
  r.setProperty("--border",      c.border);
  r.setProperty("--border-2",    c.border2);
  r.setProperty("--text",        c.text);
  r.setProperty("--text-2",      c.text2);
  r.setProperty("--text-3",      c.text3);
  r.setProperty("--accent",      c.accent);
  r.setProperty("--accent-dim",  c.accentBg);
  // Names used by styles.css.
  for (const [k, v] of Object.entries({
    surface: c.surface, raised: c.raised, raised2: c.raised2, border2: c.border2,
    text2: c.text2, text3: c.text3, "accent-bg": c.accentBg, "accent-line": c.accentLine,
    "accent-text": c.accentText, grad: c.grad, glow: c.glow, sidebar: c.sidebar,
    shadow: c.shadow, "shadow-hi": c.shadowHi,
  })) r.setProperty(`--${k}`, v);
  for (const [name, sev] of Object.entries({ crit: "critical", high: "high", med: "medium", low: "low", info: "info" })) {
    r.setProperty(`--${name}`, theme.sev[sev].fg);
    r.setProperty(`--${name}-solid`, theme.sev[sev].solid);
    r.setProperty(`--${name}-bg`, theme.sev[sev].bg);
  }
  const st = (k) => theme.status[k][isLight ? "light" : "dark"];
  r.setProperty("--ok", st("signed_off"));
  r.setProperty("--ok-bg", `${st("signed_off")}1f`);
  r.setProperty("--run", c.accent);
  document.documentElement.dataset.theme = theme.mode;
  const green  = theme.status.signed_off[isLight ? "light" : "dark"];
  const red    = theme.sev.critical.fg;
  const orange = theme.sev.high.fg;
  const yellow = theme.sev.medium.fg;
  const blue   = theme.sev.low.fg;
  r.setProperty("--green",       green);
  r.setProperty("--green-dim",   `${green}1a`);
  r.setProperty("--red",         red);
  r.setProperty("--red-dim",     `${red}1a`);
  r.setProperty("--orange",      orange);
  r.setProperty("--orange-dim",  `${orange}1a`);
  r.setProperty("--yellow",      yellow);
  r.setProperty("--yellow-dim",  `${yellow}1a`);
  r.setProperty("--blue",        blue);
  r.setProperty("--blue-dim",    `${blue}1a`);
  r.setProperty("--purple",      isLight ? "#7c3aed" : "#bc8cff");
  r.setProperty("--purple-dim",  isLight ? "rgba(124,58,237,0.1)" : "rgba(188,140,255,0.1)");
  r.setProperty("--radius",      `${theme.radius}px`);
  r.setProperty("--radius-lg",   `${theme.radiusLg}px`);
  document.body.style.background = c.bg;
  document.body.style.color = c.text;
}
