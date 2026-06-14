// flux-term cell shader — one instanced quad per cell.
// v0 draws solid bg + placeholder fg quad; glyph-atlas sampling is issue #7.

struct CellIn {
    @location(0) pos:   u32, // col | row << 16
    @location(1) glyph: u32,
    @location(2) fg:    u32, // 0xRRGGBBAA
    @location(3) bg:    u32,
};

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) bg: vec4<f32>,
};

// Cell size in NDC — uniforms (issue #7) replace these constants.
const CELL_W: f32 = 2.0 / 240.0;
const CELL_H: f32 = 2.0 / 60.0;

fn unpack_rgba(c: u32) -> vec4<f32> {
    return vec4<f32>(
        f32((c >> 24u) & 0xffu) / 255.0,
        f32((c >> 16u) & 0xffu) / 255.0,
        f32((c >>  8u) & 0xffu) / 255.0,
        f32( c         & 0xffu) / 255.0,
    );
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, cell: CellIn) -> VsOut {
    let col = f32(cell.pos & 0xffffu);
    let row = f32(cell.pos >> 16u);
    // Triangle-strip corner from vertex index: (0,0)(1,0)(0,1)(1,1).
    let corner = vec2<f32>(f32(vi & 1u), f32(vi >> 1u));
    let x = -1.0 + (col + corner.x) * CELL_W;
    let y =  1.0 - (row + corner.y) * CELL_H;

    var out: VsOut;
    out.clip = vec4<f32>(x, y, 0.0, 1.0);
    out.bg = unpack_rgba(cell.bg);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return in.bg;
}
