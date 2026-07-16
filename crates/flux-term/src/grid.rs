//! Screen grid: a flat `Vec<Cell>` (row-major, cache-friendly — the renderer
//! walks it linearly every frame) plus per-row damage flags so the GPU only
//! re-uploads rows that actually changed.
//!
//! Scrollback + reflow (#9): rows scrolled off the top are kept in a bounded ring
//! buffer instead of discarded, and `resize` re-wraps content to the new width
//! (soft-wrapped lines are joined into logical lines, then re-split) rather than
//! clearing the screen. A per-row `wrapped` flag records whether a line continued
//! onto the next — the bit reflow needs to reconstruct logical lines.

use std::collections::VecDeque;

/// A stored line (a scrolled-off screen row, or an intermediate during reflow).
/// `wrapped` = this line soft-wrapped into the next (no hard newline), so reflow
/// joins it with its successor.
#[derive(Debug, Clone)]
struct Line {
    cells: Vec<Cell>,
    wrapped: bool,
}

/// Trailing default cells are padding on a hard-broken line — drop them before
/// re-wrapping so a half-full row doesn't carry blanks into the joined logical line.
fn trim_trailing_blanks(cells: &[Cell]) -> &[Cell] {
    let mut end = cells.len();
    while end > 0 && cells[end - 1] == Cell::default() {
        end -= 1;
    }
    &cells[..end]
}

/// One terminal cell. Kept at 8 bytes (char 4 + fg 3 + flags 1 via packing
/// in a follow-up; v0 favors clarity) — a 240×60 grid is ~115 KB hot data.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    pub ch: char,
    pub fg: Color,
    pub bg: Color,
    pub flags: CellFlags,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            ch: ' ',
            fg: Color::Default,
            bg: Color::Default,
            flags: CellFlags::empty(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    Default,
    /// Classic 16/256 palette index — resolved to the Flux theme at render.
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellFlags(u8);

impl CellFlags {
    pub const BOLD: Self = Self(1 << 0);
    pub const ITALIC: Self = Self(1 << 1);
    pub const UNDERLINE: Self = Self(1 << 2);
    pub const INVERSE: Self = Self(1 << 3);

    pub fn empty() -> Self {
        Self(0)
    }
    pub fn set(&mut self, f: Self) {
        self.0 |= f.0;
    }
    pub fn clear(&mut self, f: Self) {
        self.0 &= !f.0;
    }
    pub fn contains(self, f: Self) -> bool {
        self.0 & f.0 == f.0
    }
}

pub struct Grid {
    cols: u16,
    rows: u16,
    cells: Vec<Cell>,
    /// Damage flags, one per row. The renderer drains these each frame.
    damaged: Vec<bool>,
    /// Per-row soft-wrap flag: row `r` wrapped into `r+1` (no hard newline).
    wrapped: Vec<bool>,
    /// Bounded ring buffer of rows scrolled off the top (oldest at the front).
    scrollback: VecDeque<Line>,
    max_scrollback: usize,
    cursor: (u16, u16), // (col, row)
    /// Pen state set by SGR sequences, applied to subsequently printed cells.
    pen_fg: Color,
    pen_bg: Color,
    pen_flags: CellFlags,
}

impl Grid {
    /// Default scrollback cap (rows). ~10k × a typical row ≈ a few MB.
    const DEFAULT_SCROLLBACK: usize = 10_000;

    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            cells: vec![Cell::default(); cols as usize * rows as usize],
            damaged: vec![true; rows as usize],
            wrapped: vec![false; rows as usize],
            scrollback: VecDeque::new(),
            max_scrollback: Self::DEFAULT_SCROLLBACK,
            cursor: (0, 0),
            pen_fg: Color::Default,
            pen_bg: Color::Default,
            pen_flags: CellFlags::empty(),
        }
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }
    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn cell(&self, col: u16, row: u16) -> Option<&Cell> {
        self.cells
            .get(row as usize * self.cols as usize + col as usize)
    }

    /// Drain damage: returns which rows changed and resets the flags.
    /// Called once per rendered frame.
    pub fn take_damage(&mut self) -> Vec<u16> {
        let mut out = Vec::new();
        for (i, d) in self.damaged.iter_mut().enumerate() {
            if std::mem::take(d) {
                out.push(i as u16);
            }
        }
        out
    }

    /// Debug/test helper: row contents as a trimmed string.
    pub fn row_text(&self, row: u16) -> String {
        let start = row as usize * self.cols as usize;
        self.cells[start..start + self.cols as usize]
            .iter()
            .map(|c| c.ch)
            .collect()
    }

    /// Rows currently held in scrollback.
    pub fn scrollback_len(&self) -> usize {
        self.scrollback.len()
    }
    /// Text of scrollback row `i` (0 = oldest) — for rendering the scroll region / tests.
    pub fn scrollback_row_text(&self, i: usize) -> Option<String> {
        self.scrollback
            .get(i)
            .map(|l| l.cells.iter().map(|c| c.ch).collect())
    }

    /// Collapse scrollback + screen into logical lines, joining soft-wrapped rows
    /// and trimming the trailing padding off hard-broken ones.
    fn logical_lines(&self) -> Vec<Vec<Cell>> {
        let mut out: Vec<Vec<Cell>> = Vec::new();
        let mut cur: Vec<Cell> = Vec::new();
        let feed =
            |cells: &[Cell], wrapped: bool, out: &mut Vec<Vec<Cell>>, cur: &mut Vec<Cell>| {
                if wrapped {
                    cur.extend_from_slice(cells);
                } else {
                    cur.extend_from_slice(trim_trailing_blanks(cells));
                    out.push(std::mem::take(cur));
                }
            };
        for line in &self.scrollback {
            feed(&line.cells, line.wrapped, &mut out, &mut cur);
        }
        for r in 0..self.rows as usize {
            let start = r * self.cols as usize;
            feed(
                &self.cells[start..start + self.cols as usize],
                self.wrapped[r],
                &mut out,
                &mut cur,
            );
        }
        if !cur.is_empty() {
            out.push(cur);
        }
        out
    }

    /// Reflow-preserving resize (#9): re-wrap every logical line to the new width
    /// instead of clearing. The most recent `rows` lines become the screen; the
    /// rest go to scrollback. The cursor lands at the end of the last content line.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 || (cols == self.cols && rows == self.rows) {
            return;
        }
        // Re-wrap each logical line into `cols`-wide rows (all but the last wrapped).
        let mut wrapped_lines: Vec<Line> = Vec::new();
        for line in self.logical_lines() {
            if line.is_empty() {
                wrapped_lines.push(Line {
                    cells: Vec::new(),
                    wrapped: false,
                });
                continue;
            }
            let w = cols as usize;
            let mut i = 0;
            while i < line.len() {
                let end = (i + w).min(line.len());
                wrapped_lines.push(Line {
                    cells: line[i..end].to_vec(),
                    wrapped: end < line.len(),
                });
                i = end;
            }
        }
        // Drop trailing blank lines so shrinking rows doesn't shove visible content
        // into scrollback when there's empty space at the bottom.
        while wrapped_lines.len() > 1 && wrapped_lines.last().is_some_and(|l| l.cells.is_empty()) {
            wrapped_lines.pop();
        }
        // The last `rows` lines are the screen; earlier ones are scrollback.
        while wrapped_lines.len() < rows as usize {
            wrapped_lines.push(Line {
                cells: Vec::new(),
                wrapped: false,
            });
        }
        let split = wrapped_lines.len() - rows as usize;
        let screen: Vec<Line> = wrapped_lines.split_off(split);

        let mut cells = vec![Cell::default(); cols as usize * rows as usize];
        let mut wrap = vec![false; rows as usize];
        let mut last_content = (0u16, 0u16); // (len, row) of the last non-empty line
        for (r, line) in screen.iter().enumerate() {
            let start = r * cols as usize;
            for (c, cell) in line.cells.iter().take(cols as usize).enumerate() {
                cells[start + c] = *cell;
            }
            wrap[r] = line.wrapped;
            if !line.cells.is_empty() {
                last_content = (line.cells.len().min(cols as usize) as u16, r as u16);
            }
        }
        self.scrollback = wrapped_lines.into_iter().collect();
        while self.scrollback.len() > self.max_scrollback {
            self.scrollback.pop_front();
        }
        self.cols = cols;
        self.rows = rows;
        self.cells = cells;
        self.wrapped = wrap;
        self.damaged = vec![true; rows as usize];
        self.cursor = (last_content.0.min(cols - 1), last_content.1.min(rows - 1));
    }

    fn put(&mut self, ch: char) {
        let (col, row) = self.cursor;
        let idx = row as usize * self.cols as usize + col as usize;
        if let Some(cell) = self.cells.get_mut(idx) {
            *cell = Cell {
                ch,
                fg: self.pen_fg,
                bg: self.pen_bg,
                flags: self.pen_flags,
            };
            self.damaged[row as usize] = true;
        }
        // Advance with wrap. A wrap means this row continues onto the next, so
        // mark it soft-wrapped (reflow joins them back into one logical line).
        if col + 1 < self.cols {
            self.cursor.0 = col + 1;
        } else {
            self.wrapped[row as usize] = true;
            self.cursor.0 = 0;
            self.linefeed();
        }
    }

    fn linefeed(&mut self) {
        if self.cursor.1 + 1 < self.rows {
            self.cursor.1 += 1;
        } else {
            // Scroll: row 0 leaves the screen — keep it in scrollback (with its
            // wrap flag, so reflow can rejoin it) instead of discarding it.
            let w = self.cols as usize;
            let evicted: Vec<Cell> = self.cells[..w].to_vec();
            self.scrollback.push_back(Line {
                cells: evicted,
                wrapped: self.wrapped[0],
            });
            while self.scrollback.len() > self.max_scrollback {
                self.scrollback.pop_front();
            }
            self.cells.copy_within(w.., 0);
            let len = self.cells.len();
            self.cells[len - w..].fill(Cell::default());
            // Shift wrap flags up to match; the new bottom row starts unwrapped.
            self.wrapped.copy_within(1.., 0);
            *self.wrapped.last_mut().unwrap() = false;
            self.damaged.iter_mut().for_each(|d| *d = true);
        }
    }
}

/// vte::Perform — the parser calls these as it recognizes ANSI sequences.
/// Only the subset needed for a working shell is wired; the rest logs at
/// trace level so unimplemented sequences are discoverable, never silent.
impl vte::Perform for Grid {
    fn print(&mut self, c: char) {
        self.put(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => self.linefeed(),
            b'\r' => self.cursor.0 = 0,
            b'\x08' => self.cursor.0 = self.cursor.0.saturating_sub(1), // BS
            b'\t' => {
                // Tab stops every 8 columns.
                let next = ((self.cursor.0 / 8) + 1) * 8;
                self.cursor.0 = next.min(self.cols - 1);
            }
            _ => tracing::trace!(target: "flux::term", byte, "unhandled C0"),
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        _intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        match action {
            // SGR — colors and attributes.
            'm' => {
                for p in params.iter() {
                    match p[0] {
                        0 => {
                            self.pen_fg = Color::Default;
                            self.pen_bg = Color::Default;
                            self.pen_flags = CellFlags::empty();
                        }
                        1 => self.pen_flags.set(CellFlags::BOLD),
                        3 => self.pen_flags.set(CellFlags::ITALIC),
                        4 => self.pen_flags.set(CellFlags::UNDERLINE),
                        7 => self.pen_flags.set(CellFlags::INVERSE),
                        30..=37 => self.pen_fg = Color::Indexed(p[0] as u8 - 30),
                        40..=47 => self.pen_bg = Color::Indexed(p[0] as u8 - 40),
                        90..=97 => self.pen_fg = Color::Indexed(p[0] as u8 - 90 + 8),
                        39 => self.pen_fg = Color::Default,
                        49 => self.pen_bg = Color::Default,
                        _ => tracing::trace!(target: "flux::term", sgr = p[0], "unhandled SGR"),
                    }
                }
            }
            // CUP — cursor position (1-based in the protocol).
            'H' => {
                let mut it = params.iter();
                let row = it.next().map_or(1, |p| p[0].max(1));
                let col = it.next().map_or(1, |p| p[0].max(1));
                self.cursor = ((col - 1).min(self.cols - 1), (row - 1).min(self.rows - 1));
            }
            // ED — erase display (mode 2: all).
            'J' => {
                self.cells.fill(Cell::default());
                self.wrapped.iter_mut().for_each(|w| *w = false);
                self.damaged.iter_mut().for_each(|d| *d = true);
            }
            _ => tracing::trace!(target: "flux::term", %action, "unhandled CSI"),
        }
    }
}
