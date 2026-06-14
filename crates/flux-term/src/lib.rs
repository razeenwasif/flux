//! flux-term: the embedded, WGPU-accelerated terminal.
//!
//! Architecture (Alacritty-inspired, adapted to live *inside* a window):
//!
//!   PTY bytes ──▶ vte::Parser ──▶ Grid (cells + damage) ──▶ GPU renderer
//!                                     ▲
//!         flux-core injects FLUX_TAB_* env at shell spawn (context-aware)
//!
//! The renderer (feature = "gpu") draws ONLY damaged rows via an instanced
//! glyph-atlas pipeline — one draw call per frame, <8 ms at 4k dirty cells
//! (budget, ADR 0001). It renders into a wgpu surface composited as its own
//! pane in the Flux window, beneath the SolidJS chrome.

pub mod grid;
#[cfg(feature = "gpu")]
pub mod renderer;

use grid::Grid;

/// A live terminal session: parser state + screen grid.
/// PTY I/O lives in flux-core (it owns process spawning and the env bridge);
/// this type is pure "bytes in → cells out", which keeps it trivially testable.
pub struct Terminal {
    parser: vte::Parser,
    grid: Grid,
}

impl Terminal {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { parser: vte::Parser::new(), grid: Grid::new(cols, rows) }
    }

    /// Feed raw PTY output. Damage tracking happens inside the grid, so the
    /// renderer can later ask "which rows changed since last frame?".
    pub fn advance(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.parser.advance(&mut self.grid, b);
        }
    }

    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.grid.resize(cols, rows);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_lands_in_cells() {
        let mut t = Terminal::new(80, 24);
        t.advance(b"flux> ");
        let row = t.grid().row_text(0);
        assert!(row.starts_with("flux> "));
    }

    #[test]
    fn sgr_color_is_applied() {
        let mut t = Terminal::new(80, 24);
        // ESC[36m → cyan foreground (the Flux teal maps here in the theme).
        t.advance(b"\x1b[36mteal\x1b[0m");
        let cell = t.grid().cell(0, 0).unwrap();
        assert_eq!(cell.fg, grid::Color::Indexed(6));
    }

    #[test]
    fn newline_and_cr_move_cursor() {
        let mut t = Terminal::new(80, 24);
        t.advance(b"a\r\nb");
        assert!(t.grid().row_text(0).starts_with('a'));
        assert!(t.grid().row_text(1).starts_with('b'));
    }
}
