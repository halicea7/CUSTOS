const sevLight = {
  critical: { fg: "#c2241a", solid: "#dc2626", bg: "#fdeceb", label: "Critical", short: "CRIT" },
  high:     { fg: "#b4530c", solid: "#ea7317", bg: "#fdf0e6", label: "High",     short: "HIGH" },
  medium:   { fg: "#9a6c0e", solid: "#d29922", bg: "#fbf3df", label: "Medium",   short: "MED"  },
  low:      { fg: "#1f6fd6", solid: "#2f7ee0", bg: "#eaf2fd", label: "Low",      short: "LOW"  },
  info:     { fg: "#5a6473", solid: "#7b8696", bg: "#eef1f5", label: "Info",     short: "INFO" },
};
const sevDark = {
  critical: { fg: "#ff6b63", solid: "#f85149", bg: "rgba(248,81,73,0.14)",    label: "Critical", short: "CRIT" },
  high:     { fg: "#f0883e", solid: "#e3650a", bg: "rgba(227,101,10,0.15)",   label: "High",     short: "HIGH" },
  medium:   { fg: "#e3b341", solid: "#d29922", bg: "rgba(210,153,34,0.15)",   label: "Medium",   short: "MED"  },
  low:      { fg: "#58a6ff", solid: "#388bfd", bg: "rgba(56,139,253,0.15)",   label: "Low",      short: "LOW"  },
  info:     { fg: "#9aa4b2", solid: "#6e7a8a", bg: "rgba(139,148,158,0.14)", label: "Info",     short: "INFO" },
};

export const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

export const STATUS_META = {
  pending:    { label: "Pending",    dark: "#9aa4b2", light: "#7b8696" },
  analyzing:  { label: "Analyzing",  dark: "#58a6ff", light: "#2f7ee0" },
  reviewed:   { label: "Reviewed",   dark: "#e3b341", light: "#b4870c" },
  signed_off: { label: "Signed off", dark: "#3fb950", light: "#1f9d4d" },
};

export const HEALTH_META = {
  healthy: { label: "Healthy", light: "#1f9d4d", dark: "#3fb950" },
  warning: { label: "Warning", light: "#b4530c", dark: "#f0883e" },
  urgent:  { label: "Urgent",  light: "#c2241a", dark: "#ff6b63" },
};

export const CAT_COLORS = {
  light: { sast: "#2f7ee0", secrets: "#dc2626", dependencies: "#d29922", config: "#ea7317", llm: "#7c3aed" },
  dark:  { sast: "#58a6ff", secrets: "#f85149", dependencies: "#e3b341", config: "#f0883e", llm: "#bc8cff" },
};

const light = {
  bg: "#f5f6f8", surface: "#ffffff", raised: "#fafbfc", raised2: "#f3f4f7",
  border: "#e6e8ec", border2: "#d4d8df",
  text: "#181b22", text2: "#5a6473", text3: "#95a0b0",
  accent: "#4f46e5", accentBg: "rgba(79,70,229,0.1)", accentText: "#ffffff", link: "#4f46e5",
  shadow: "0 1px 2px rgba(20,24,40,0.05)", shadowHi: "0 14px 34px rgba(20,24,40,0.12)",
};
const dark = {
  bg: "#0d0f14", surface: "#15181f", raised: "#1a1e26", raised2: "#20252f",
  border: "#262b35", border2: "#363d49",
  text: "#e7eaf0", text2: "#9aa3b3", text3: "#616b7b",
  accent: "#7c79f2", accentBg: "rgba(124,121,242,0.18)", accentText: "#0d0f14", link: "#8f8cff",
  shadow: "0 1px 2px rgba(0,0,0,0.4)", shadowHi: "0 16px 38px rgba(0,0,0,0.5)",
};

export function makeTheme(mode) {
  const isLight = mode === "light";
  return {
    mode,
    radius: 10, radiusLg: 16,
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
