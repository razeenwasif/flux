//! Screen grid: a flat `Vec<Cell>` (row-major, cache-friendly — the renderer
//! walks it linearly every frame) plus per-row damage flags so the GPU only
//! re-uploads rows that actually changed.

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
        Self { ch: ' ', fg: Color::Default, bg: Color::Default, flags: CellFlags::empty() }
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
    cursor: (u16, u16), // (col, row)
    /// Pen state set by SGR sequences, applied to subsequently printed cells.
    pen_fg: Color,
    pen_bg: Color,
    pen_flags: CellFlags,
}

impl Grid {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            cells: vec![Cell::default(); cols as usize * rows as usize],
            damaged: vec![true; rows as usize],
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
        self.cells.get(row as usize * self.cols as usize + col as usize)
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
        self.cells[start..start + self.cols as usize].iter().map(|c| c.ch).collect()
    }

    /// Naive resize (clear + redraw). Reflow-preserving resize is issue #9 —
    /// it needs the scrollback ring buffer first.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        *self = Grid::new(cols, rows);
    }

    fn put(&mut self, ch: char) {
        let (col, row) = self.cursor;
        let idx = row as usize * self.cols as usize + col as usize;
        if let Some(cell) = self.cells.get_mut(idx) {
            *cell = Cell { ch, fg: self.pen_fg, bg: self.pen_bg, flags: self.pen_flags };
            self.damaged[row as usize] = true;
        }
        // Advance with wrap.
        if col + 1 < self.cols {
            self.cursor.0 = col + 1;
        } else {
            self.cursor.0 = 0;
            self.linefeed();
        }
    }

    fn linefeed(&mut self) {
        if self.cursor.1 + 1 < self.rows {
            self.cursor.1 += 1;
        } else {
            // Scroll: rotate row 0 out. Scrollback ring buffer is issue #9.
            let w = self.cols as usize;
            self.cells.copy_within(w.., 0);
            let len = self.cells.len();
            self.cells[len - w..].fill(Cell::default());
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
                let row = it.next().map_or(1, |p| p[0].max(1)) as u16;
                let col = it.next().map_or(1, |p| p[0].max(1)) as u16;
                self.cursor = ((col - 1).min(self.cols - 1), (row - 1).min(self.rows - 1));
            }
            // ED — erase display (mode 2: all).
            'J' => {
                self.cells.fill(Cell::default());
                self.damaged.iter_mut().for_each(|d| *d = true);
            }
            _ => tracing::trace!(target: "flux::term", %action, "unhandled CSI"),
        }
    }
}
