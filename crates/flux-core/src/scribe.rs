//! Scribe — handwritten, per-course notebooks (GoodNotes-style) that publish to
//! the Onyx vault (ADR 0014).
//!
//! The ink itself is drawn by the shell's shared `InkCanvas` (the same vector
//! engine as `flux://whiteboard`), so this store keeps strokes **opaque**: each
//! page holds the ink as a JSON string it never interprets. That decouples
//! persistence from the ink format entirely — the engine can grow new stroke
//! kinds with zero Rust or bindings churn.
//!
//! Storage is one JSON file per notebook under `<app_data>/scribe/<id>.json`
//! (best-effort atomic writes via `crate::persist`), so a 500 ms autosave only
//! rewrites the notebook you're editing, not the whole shelf. Publishing a page
//! is **one-way**: Onyx is a Markdown TUI that can't render strokes, so a page
//! becomes a `.md` holding an embedded PNG of the ink plus a text body — a
//! searchable, KB-indexable mirror. Scribe stays the source of truth for ink.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

/// One page of a notebook. `strokes` is the ink engine's `Stroke[]` serialized
/// to JSON — opaque here on purpose (see module docs).
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Page {
    pub id: String,
    /// Paper background: `plain` | `grid` | `lined` | `squared`.
    pub template: String,
    /// Opaque JSON — the ink engine's stroke array. Never parsed by Rust.
    pub strokes: String,
    pub ts: u64,
}

/// A course notebook: an ordered list of fixed-size pages you flip through.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub course: Option<String>,
    /// Accent colour for the shelf card (hex), optional.
    pub tint: Option<String>,
    pub pages: Vec<Page>,
    pub created: u64,
    pub ts: u64,
}

/// The written half of a published page — what ends up as Markdown around the
/// embedded ink. Grouped so `scribe_publish_page` takes one coherent argument
/// rather than a run of loose strings.
#[derive(Deserialize, specta::Type)]
pub struct PageNote {
    pub title: String,
    /// Free text; the drop-in target for Gemma's handwriting transcription.
    pub body: String,
    /// Raw tag input — commas or spaces, `#` optional (see `parse_tags`).
    pub tags: Option<String>,
}

/// Shelf-list view of a notebook — no strokes, so listing stays cheap.
#[derive(Serialize, Clone, specta::Type)]
pub struct NotebookMeta {
    pub id: String,
    pub name: String,
    pub course: Option<String>,
    pub tint: Option<String>,
    pub page_count: u32,
    pub ts: u64,
}

#[derive(Default)]
pub struct ScribeStore {
    books: RwLock<HashMap<String, Notebook>>,
    dir: Option<PathBuf>,
    /// Monotonic tiebreaker so two notebooks created in the same millisecond
    /// still get distinct ids.
    seq: AtomicU64,
}

impl ScribeStore {
    /// Load every `<dir>/*.json` notebook into memory (best-effort; a corrupt
    /// file is skipped, never fatal).
    pub fn restore(dir: PathBuf) -> Self {
        let mut books = HashMap::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Some(nb) = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Notebook>(&s).ok())
                {
                    books.insert(nb.id.clone(), nb);
                }
            }
        }
        Self {
            books: RwLock::new(books),
            dir: Some(dir),
            seq: AtomicU64::new(0),
        }
    }

    /// Shelf list, newest first.
    pub fn list(&self) -> Vec<NotebookMeta> {
        let mut metas: Vec<NotebookMeta> = self
            .books
            .read()
            .values()
            .map(|nb| NotebookMeta {
                id: nb.id.clone(),
                name: nb.name.clone(),
                course: nb.course.clone(),
                tint: nb.tint.clone(),
                page_count: nb.pages.len() as u32,
                ts: nb.ts,
            })
            .collect();
        metas.sort_by_key(|m| std::cmp::Reverse(m.ts));
        metas
    }

    pub fn load(&self, id: &str) -> Option<Notebook> {
        self.books.read().get(id).cloned()
    }

    /// Create an empty notebook with one blank page and persist it.
    pub fn create(&self, name: String, course: Option<String>) -> Notebook {
        let now = now_ms();
        let id = format!("nb-{now}-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let name = {
            let n = name.trim();
            if n.is_empty() {
                "Untitled notebook".to_string()
            } else {
                n.to_string()
            }
        };
        let course = course.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        let nb = Notebook {
            pages: vec![Page {
                id: format!("pg-{now}"),
                template: "grid".to_string(),
                strokes: "[]".to_string(),
                ts: now,
            }],
            id,
            name,
            course,
            tint: None,
            created: now,
            ts: now,
        };
        self.books.write().insert(nb.id.clone(), nb.clone());
        self.write(&nb);
        nb
    }

    /// Replace a notebook wholesale (the frontend's debounced autosave). Bumps
    /// `ts` so the shelf reorders to most-recently-touched.
    pub fn save(&self, mut nb: Notebook) {
        nb.ts = now_ms();
        self.books.write().insert(nb.id.clone(), nb.clone());
        self.write(&nb);
    }

    pub fn delete(&self, id: &str) {
        self.books.write().remove(id);
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
        }
    }

    fn write(&self, nb: &Notebook) {
        let Some(dir) = &self.dir else { return };
        crate::persist::save_json(&dir.join(format!("{}.json", nb.id)), nb);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Today as `YYYY-MM-DD` (UTC) via Howard Hinnant's civil-from-days — avoids
/// pulling a date crate for a single frontmatter line.
pub(crate) fn today_ymd() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

/// Escape a value for a double-quoted YAML frontmatter scalar (keep it simple:
/// backslashes and quotes are the only chars that break the line).
pub(crate) fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn scribe_list(store: State<'_, ScribeStore>) -> Vec<NotebookMeta> {
    store.list()
}

#[tauri::command]
pub fn scribe_load(store: State<'_, ScribeStore>, id: String) -> Result<Notebook, String> {
    store.load(&id).ok_or_else(|| "notebook not found".to_string())
}

#[tauri::command]
pub fn scribe_create(
    store: State<'_, ScribeStore>,
    name: String,
    course: Option<String>,
) -> Notebook {
    store.create(name, course)
}

#[tauri::command]
pub fn scribe_save(store: State<'_, ScribeStore>, notebook: Notebook) {
    store.save(notebook);
}

#[tauri::command]
pub fn scribe_delete(store: State<'_, ScribeStore>, id: String) {
    store.delete(&id);
}

/// Publish one page to the Onyx vault: a `.md` (frontmatter + embedded PNG of
/// the ink + `body` text) under `<vault>/<course>/`, with the rendered PNG in
/// `assets/`. One-way — the note is a searchable, KB-indexable mirror. Fails
/// loud (never silently) when the vault path isn't set, per Flux's no-silent-
/// failure rule. `png_b64` is the shell-rendered PNG (base64, no data: prefix).
#[tauri::command]
pub async fn scribe_publish_page(
    scribe: State<'_, ScribeStore>,
    kb: State<'_, crate::kb::KbStore>,
    id: String,
    page_index: u32,
    note: PageNote,
    png_b64: String,
) -> Result<String, String> {
    let nb = scribe.load(&id).ok_or_else(|| "notebook not found".to_string())?;
    let course = nb.course.clone();
    let location = kb.source_location("onyx");
    tauri::async_runtime::spawn_blocking(move || {
        publish_page(
            location.as_deref(),
            course.as_deref(),
            page_index,
            &note,
            &png_b64,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Split a free-typed tag string ("kkt, duality  convexity" or "#kkt #duality")
/// into clean tag tokens. Commas or whitespace separate; a leading `#` is
/// dropped so both habits work. Shared with the agent's "save to Onyx" path so
/// hand-typed and spoken tags normalize identically.
pub(crate) fn parse_tags(raw: &str) -> Vec<String> {
    raw.split([',', ' ', '\t', '\n'])
        .map(|t| t.trim().trim_start_matches('#').trim())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

fn publish_page(
    location: Option<&str>,
    course: Option<&str>,
    page_index: u32,
    note: &PageNote,
    png_b64: &str,
) -> Result<String, String> {
    let title = note.title.as_str();
    let body = note.body.as_str();
    let tags = note.tags.as_deref();
    let root = crate::kb::onyx_vault(location).ok_or_else(|| {
        "Onyx vault not found — set its path in the Notebook panel (KB) first.".to_string()
    })?;
    let folder = course
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("Flux Scribe");
    let dir = root.join(folder);
    let assets = dir.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| format!("{}: {e}", assets.display()))?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_b64.trim())
        .map_err(|e| format!("bad image data: {e}"))?;

    let slug = crate::kb::sanitize_note_name(title);
    let page_no = page_index + 1;
    // Disambiguate the PNG so re-publishing a page doesn't clobber a prior one.
    let mut img_name = format!("{slug}-p{page_no}.png");
    let mut n = 2;
    while assets.join(&img_name).exists() {
        img_name = format!("{slug}-p{page_no} {n}.png");
        n += 1;
    }
    let img_path = assets.join(&img_name);
    std::fs::write(&img_path, &bytes).map_err(|e| format!("{}: {e}", img_path.display()))?;

    let mut md_path = dir.join(format!("{slug}.md"));
    let mut n = 2;
    while md_path.exists() {
        md_path = dir.join(format!("{slug} {n}.md"));
        n += 1;
    }
    let course_line = course
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| format!("course: {}\n", yaml_quote(c)))
        .unwrap_or_default();
    // Onyx reads YAML frontmatter, so tags go out as a real list (the form its
    // TUI and the KB's frontmatter stripper both understand).
    let tag_list = tags.map(parse_tags).unwrap_or_default();
    let tags_line = if tag_list.is_empty() {
        String::new()
    } else {
        let items = tag_list
            .iter()
            .map(|t| format!("  - {}\n", yaml_quote(t)))
            .collect::<String>();
        format!("tags:\n{items}")
    };
    let md = format!(
        "---\ntitle: {}\n{}{}source: flux-scribe\npage: {}\ndate: {}\n---\n\n# {}\n\n![handwritten](assets/{})\n\n{}\n",
        yaml_quote(title.trim()),
        course_line,
        tags_line,
        page_no,
        today_ymd(),
        title.trim(),
        img_name,
        body.trim(),
    );
    std::fs::write(&md_path, md).map_err(|e| format!("{}: {e}", md_path.display()))?;
    Ok(md_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flux-scribe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_save_load_roundtrips_and_persists() {
        let dir = scratch("roundtrip");
        let store = ScribeStore::restore(dir.clone());
        let mut nb = store.create("Calculus".into(), Some("MATH1013".into()));
        assert_eq!(nb.pages.len(), 1);
        assert_eq!(store.list().len(), 1);

        // Draw on the page + add a second page, then autosave.
        nb.pages[0].strokes = r##"[{"t":"pen","color":"#fff","w":3,"pts":[]}]"##.into();
        nb.pages.push(Page {
            id: "pg-2".into(),
            template: "lined".into(),
            strokes: "[]".into(),
            ts: 1,
        });
        store.save(nb.clone());

        // A fresh store restored from disk sees the saved strokes + both pages.
        let reopened = ScribeStore::restore(dir.clone());
        let got = reopened.load(&nb.id).expect("notebook persisted");
        assert_eq!(got.pages.len(), 2);
        assert!(got.pages[0].strokes.contains("pen"));
        assert_eq!(reopened.list()[0].page_count, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_removes_from_memory_and_disk() {
        let dir = scratch("delete");
        let store = ScribeStore::restore(dir.clone());
        let nb = store.create("Algebra".into(), None);
        let file = dir.join(format!("{}.json", nb.id));
        assert!(file.exists());
        store.delete(&nb.id);
        assert!(store.load(&nb.id).is_none());
        assert!(!file.exists());
        assert!(store.list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_seeds_a_blank_grid_page_and_trims_names() {
        let store = ScribeStore::default();
        let nb = store.create("  Linear Algebra  ".into(), Some("  ".into()));
        assert_eq!(nb.name, "Linear Algebra");
        assert_eq!(nb.course, None); // blank course drops to None
        assert_eq!(nb.pages[0].template, "grid");
        assert_eq!(nb.pages[0].strokes, "[]");
        // Blank name falls back rather than persisting an empty title.
        assert_eq!(store.create("   ".into(), None).name, "Untitled notebook");
    }

    #[test]
    fn publish_writes_md_and_png_into_course_folder() {
        let vault = scratch("vault");
        // 1x1 transparent PNG.
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQCa2iZ9AAAAAElFTkSuQmCC";
        let vault_str = vault.to_string_lossy().into_owned();
        let path = publish_page(
            Some(&vault_str),
            Some("MATH1013"),
            0,
            &PageNote {
                title: "Integration by parts".into(),
                body: "u-substitution recap".into(),
                tags: Some("#calculus, integration  by-parts".into()),
            },
            png_b64,
        )
        .expect("publish");
        let md = std::fs::read_to_string(&path).unwrap();
        assert!(md.contains("source: flux-scribe"));
        assert!(md.contains("course: \"MATH1013\""));
        // Tags land as a real YAML list (Onyx + the KB both parse frontmatter).
        assert!(
            md.contains("tags:\n  - \"calculus\"\n  - \"integration\"\n  - \"by-parts\"\n"),
            "got: {md}"
        );
        assert!(md.contains("![handwritten](assets/Integration by parts-p1.png)"));
        assert!(md.contains("u-substitution recap"));
        assert!(vault
            .join("MATH1013/assets/Integration by parts-p1.png")
            .exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn tags_accept_commas_spaces_and_hashes() {
        assert_eq!(parse_tags("kkt, duality"), vec!["kkt", "duality"]);
        assert_eq!(parse_tags("#kkt #duality"), vec!["kkt", "duality"]);
        assert_eq!(parse_tags("  ,, "), Vec::<String>::new());
        assert_eq!(parse_tags("convex-opt"), vec!["convex-opt"]);
    }

    #[test]
    fn today_ymd_is_well_formed() {
        let d = today_ymd();
        assert_eq!(d.len(), 10);
        assert_eq!(d.as_bytes()[4], b'-');
        assert_eq!(d.as_bytes()[7], b'-');
    }
}
