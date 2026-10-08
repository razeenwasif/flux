export type LayoutState = {
  sidebar: boolean;
  agent: boolean;
  terminal: boolean;
  connect: boolean;
  editor: boolean;
  bars: boolean;
  dock: boolean;
  calendar: boolean;
  appDock: boolean;
  panelA: number | null;
  panelB: number | null;
};

export const LAYOUT_PRESETS = {
  browse: {
    label: "Browse",
    state: {
      sidebar: true,
      agent: false,
      terminal: false,
      connect: true,
      editor: false,
      bars: false,
      dock: false,
      calendar: false,
      appDock: false,
      panelA: null,
      panelB: null,
    },
  },
  research: {
    label: "Research",
    state: {
      sidebar: true,
      agent: true,
      terminal: false,
      connect: true,
      editor: false,
      bars: true,
      dock: false,
      calendar: false,
      appDock: false,
      panelA: null,
      panelB: null,
    },
  },
  develop: {
    label: "Develop",
    state: {
      sidebar: true,
      agent: false,
      terminal: true,
      connect: false,
      editor: true,
      bars: true,
      dock: false,
      calendar: false,
      appDock: false,
      panelA: null,
      panelB: null,
    },
  },
} satisfies Record<string, { label: string; state: LayoutState }>;
export type LayoutPreset = keyof typeof LAYOUT_PRESETS;

export function parseLayout(raw: string | null): LayoutState | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return null;
    const sample = LAYOUT_PRESETS.browse.state;
    for (const key of Object.keys(sample) as (keyof LayoutState)[]) {
      if (key === "panelA" || key === "panelB") {
        if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
      } else if (typeof value[key] !== "boolean") return null;
    }
    return value as LayoutState;
  } catch {
    return null;
  }
}

export function layoutPresetFor(state: LayoutState): LayoutPreset | "custom" {
  return (
    (Object.keys(LAYOUT_PRESETS) as LayoutPreset[]).find((key) =>
      (Object.keys(state) as (keyof LayoutState)[]).every(
        (field) => state[field] === LAYOUT_PRESETS[key].state[field],
      ),
    ) ?? "custom"
  );
}

type Intent = {
  sidebar: boolean;
  agent: boolean;
  terminal: boolean;
  panel: boolean;
  bars: boolean;
  dock: boolean;
  connect: boolean;
  editor: boolean;
};
type Widths = { sidebar: number; stack: number; panel: number; bars: number; dock: number; connect: number };

/** Reserve page space first. Hidden panels retain their requested state for wider windows. */
export function fitLayout(
  width: number,
  pageMinimum: number,
  editorRatio: number,
  want: Intent,
  widths: Widths,
): Intent {
  const out: Intent = {
    sidebar: false,
    agent: false,
    terminal: false,
    panel: false,
    bars: false,
    dock: false,
    connect: false,
    editor: false,
  };
  const rail = 72;
  // ContentArea has 12px of inset on each side, outside the page/editor row.
  let used = Math.min(pageMinimum + 24, Math.max(0, width - rail)) + rail;
  const allocate = (extra: number) => {
    if (used + extra > width) return false;
    used += extra;
    return true;
  };
  out.sidebar = want.sidebar && allocate(Math.max(0, widths.sidebar - rail));
  // The editor consumes part of ContentArea, rather than a shell grid column.
  // Reserve enough for the page to retain its minimum at the requested ratio.
  const ratio = Math.max(0.05, Math.min(0.95, editorRatio));
  out.editor = want.editor && allocate((pageMinimum + 8) / (1 - ratio) - pageMinimum);
  if ((want.agent || want.terminal) && allocate(widths.stack)) {
    out.agent = want.agent;
    out.terminal = want.terminal;
  }
  for (const key of ["panel", "bars", "dock", "connect"] as const) {
    out[key] = want[key] && allocate(widths[key]);
  }
  return out;
}

/** Smallest either half of the page/editor row may be dragged to, in px. */
export const EDITOR_MIN_PX = 220;
/** Width of `.editor-seam`; it sits between the halves, so the card ends one
 *  seam short of where the pointer is. Kept in sync with the CSS. */
export const EDITOR_SEAM_PX = 8;

/** The editor's share of the row with its seam dragged to `x`. Clamped in px,
 *  not ratio: on a narrow window a "10%" floor is still too small to use, and
 *  both halves have to stay usable. The page half also keeps `pageMinimum`, the
 *  width fitLayout reserves for it: past that, fitLayout drops the editor column
 *  mid-drag (taking the seam with it) and the persisted ratio kept it hidden on
 *  every launch. */
export function editorRatioAt(row: { left: number; width: number }, x: number, pageMinimum: number): number {
  const min = Math.min(EDITOR_MIN_PX, row.width / 3);
  const page = Math.max(min, Math.min(pageMinimum, row.width - min - EDITOR_SEAM_PX));
  const right = row.left + row.width;
  // The card's clamp carries the seam, since the card ends where the seam begins.
  const at = Math.min(right - min, Math.max(row.left + page + EDITOR_SEAM_PX, x));
  return (right - at) / row.width;
}
