import { useEffect, useRef, useState } from "react";
import type { ThemePreference } from "../types/csm";
import styles from "./TitleBar.module.css";

// Title-bar theme control (#86). A single button that cycles System → Light →
// Dark → System; main drives Electron's nativeTheme.themeSource, so the actual
// recolor happens via the renderer's prefers-color-scheme (no push channel here).
// Self-gates on window.csm?.theme: without the preload (plain browser / unit test)
// it renders a disabled placeholder instead of a dead control.

const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];
const LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

// Inline SVG per mode — not Unicode ☀/☾, which default to color emoji on some
// platforms and would read inconsistently next to the other title-bar glyphs.
function ModeGlyph({ mode }: { mode: ThemePreference }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 15,
    height: 15,
    "aria-hidden": true,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (mode === "light") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg {...common}>
        <path
          d="M12.8 9.6A5.4 5.4 0 1 1 6.4 3.2a4.3 4.3 0 0 0 6.4 6.4z"
          fill="currentColor"
          stroke="none"
        />
      </svg>
    );
  }
  // system — a monitor, conveying "follow the OS".
  return (
    <svg {...common}>
      <rect x="2.3" y="3.3" width="11.4" height="7.6" rx="1.1" />
      <path d="M6 13.4h4M8 11v2.4" />
    </svg>
  );
}

export function ThemeToggle() {
  const theme = window.csm?.theme;
  const [mode, setMode] = useState<ThemePreference>("system");
  // A click makes the user's choice authoritative: a slower theme.get() seed that
  // resolves afterward must not clobber it back to the persisted value.
  const touched = useRef(false);

  // Seed the glyph from the persisted preference; guarded so a fast unmount can't
  // setState on a dead component (StrictMode double-invoke, async resolve) and so a
  // late resolve can't overwrite an interaction that already happened.
  useEffect(() => {
    if (!theme) return;
    let active = true;
    void theme.get().then((m) => {
      if (active && !touched.current) setMode(m);
    });
    return () => {
      active = false;
    };
  }, [theme]);

  if (!theme) {
    return (
      <button
        type="button"
        className={styles.iconButton}
        disabled
        aria-label="Toggle theme (unavailable)"
        title="Toggle theme (unavailable)"
      >
        <ModeGlyph mode="system" />
      </button>
    );
  }

  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
  const onClick = (): void => {
    const prev = mode;
    touched.current = true;
    setMode(next); // optimistic; main persists + applies the visual change
    void theme.set(next).catch(() => setMode(prev));
  };

  return (
    <button
      type="button"
      className={styles.iconButton}
      onClick={onClick}
      aria-label={`Theme: ${LABEL[mode]}. Switch to ${LABEL[next]}`}
      title={`Theme: ${LABEL[mode]} (click for ${LABEL[next]})`}
    >
      <ModeGlyph mode={mode} />
    </button>
  );
}
