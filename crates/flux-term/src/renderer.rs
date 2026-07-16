//! WGPU renderer (feature = "gpu").
//!
//! Strategy — one instanced draw call per frame:
//!   * Glyph atlas: rasterized once per (font, size) into an R8 texture;
//!     cache keyed by (char, flags). Atlas growth = new texture + re-upload,
//!     amortized to ~never after the first second of use.
//!   * Per-cell instance buffer: 16 bytes/cell (grid pos, atlas uv, fg, bg).
//!     Only DAMAGED rows are re-written (queue.write_buffer on row ranges) —
//!     this is what holds the <8 ms frame budget at 4k dirty cells.
//!   * Background pass and glyph pass share the pipeline; bg is "glyph 0"
//!     (a solid quad), avoiding a second pipeline switch.

use crate::grid::Grid;

/// Per-cell GPU instance. `#[repr(C)]` + bytemuck → memcpy'd straight into
/// the instance buffer, no per-cell encode step.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CellInstance {
    /// Grid position packed as (col: u16, row: u16).
    pub pos: u32,
    /// Glyph atlas slot.
    pub glyph: u32,
    /// 0xRRGGBBAA foreground.
    pub fg: u32,
    /// 0xRRGGBBAA background.
    pub bg: u32,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    instances: wgpu::Buffer,
    /// CPU mirror of the instance buffer, indexed like the grid. Damage
    /// repair writes here first, then uploads contiguous row spans.
    mirror: Vec<CellInstance>,
}

impl Renderer {
    /// `surface` is the wgpu surface for the terminal pane (created by
    /// flux-core from the OS window handle).
    pub async fn new(
        instance: &wgpu::Instance,
        surface: &wgpu::Surface<'_>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<Self> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                // LowPower: a terminal must NEVER spin up the dGPU — that's
                // battery budget owed to the LLM.
                power_preference: wgpu::PowerPreference::LowPower,
                compatible_surface: Some(surface),
                ..Default::default()
            })
            .await
            .ok_or_else(|| anyhow::anyhow!("no wgpu adapter"))?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default(), None)
            .await?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("flux-term cells"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/cell.wgsl").into()),
        });

        let n = cols as usize * rows as usize;
        let instances = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cell instances"),
            size: (n * std::mem::size_of::<CellInstance>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let pipeline = Self::build_pipeline(&device, &shader);
        Ok(Self {
            device,
            queue,
            pipeline,
            instances,
            mirror: vec![
                CellInstance {
                    pos: 0,
                    glyph: 0,
                    fg: 0,
                    bg: 0
                };
                n
            ],
        })
    }

    /// Repair damaged rows and draw. Skeleton: glyph-atlas lookup and the
    /// actual render pass body are issue #7; the damage→upload spine below
    /// is the part that defines the performance envelope.
    pub fn render(&mut self, grid: &mut Grid, view: &wgpu::TextureView) {
        let cols = grid.cols() as usize;
        let row_bytes = (cols * std::mem::size_of::<CellInstance>()) as u64;

        for row in grid.take_damage() {
            let start = row as usize * cols;
            for col in 0..cols {
                let cell = grid.cell(col as u16, row).copied().unwrap_or_default();
                self.mirror[start + col] = CellInstance {
                    pos: (col as u32) | ((row as u32) << 16),
                    glyph: cell.ch as u32, // v0: codepoint == atlas key
                    fg: 0xE0_E6_F0_FF,     // theme resolve is issue #7
                    bg: 0x0B_13_2B_FF,     // Deep Space Blue
                };
            }
            // Upload exactly this row — the core of the <8 ms budget.
            self.queue.write_buffer(
                &self.instances,
                row as u64 * row_bytes,
                bytemuck::cast_slice(&self.mirror[start..start + cols]),
            );
        }

        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("flux-term"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Deep Space Blue #0B132B, the theme background.
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.043,
                            g: 0.0745,
                            b: 0.1686,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_vertex_buffer(0, self.instances.slice(..));
            // One instanced call: 4 verts × (cols·rows) instances.
            pass.draw(0..4, 0..self.mirror.len() as u32);
        }
        self.queue.submit([encoder.finish()]);
    }

    fn build_pipeline(device: &wgpu::Device, shader: &wgpu::ShaderModule) -> wgpu::RenderPipeline {
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor::default());
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("flux-term cells"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<CellInstance>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Uint32, 1 => Uint32, 2 => Uint32, 3 => Uint32],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Bgra8UnormSrgb,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        })
    }
}
