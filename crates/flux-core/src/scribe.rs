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
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{Manager as _, State};

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
    /// Bumped on every mutation. The KB's background indexer watches this so
    /// notebooks reach the knowledge base without a manual reindex — and, by
    /// waiting for it to settle, without re-embedding on every autosave.
    generation: AtomicU64,
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
            generation: AtomicU64::new(0),
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
    /// Bump the change counter. See `generation`.
    fn touch(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    /// How many times the store has changed. Compared across ticks by the KB
    /// indexer, never interpreted as a count of anything.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

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
        self.touch();
        nb
    }

    /// Replace a notebook wholesale (the frontend's debounced autosave). Bumps
    /// `ts` so the shelf reorders to most-recently-touched.
    pub fn save(&self, mut nb: Notebook) {
        nb.ts = now_ms();
        self.books.write().insert(nb.id.clone(), nb.clone());
        self.write(&nb);
        self.touch();
    }

    pub fn delete(&self, id: &str) {
        self.books.write().remove(id);
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
        }
        self.touch();
    }

    fn write(&self, nb: &Notebook) {
        let Some(dir) = &self.dir else { return };
        crate::persist::save_json(&dir.join(format!("{}.json", nb.id)), nb);
    }
}

/// The typed text of a page, pulled out of the opaque stroke JSON — the one
/// place that looks inside it, so the KB can index notebooks without the ink
/// format leaking further. Handwriting contributes nothing until transcription
/// exists; typed blocks do.
pub fn page_text(content_json: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content_json) else {
        return String::new();
    };
    // Document pages (v2): the prose lives in `html`.
    if let Some(html) = v.get("html").and_then(|h| h.as_str()) {
        return strip_html(html);
    }
    // Pre-document pages: an array of ink strokes, some of them typed text.
    let Some(arr) = v.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for s in arr {
        if s.get("t").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        if let Some(t) = s.get("text").and_then(|t| t.as_str()) {
            if !t.trim().is_empty() {
                out.push_str(t.trim());
                out.push('\n');
            }
        }
    }
    out
}

/// Tags out, block boundaries kept as newlines, the handful of entities an
/// editor actually emits decoded. Enough to feed retrieval — not a parser.
fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    let mut tag = String::new();
    for c in html.chars() {
        match c {
            '<' => {
                depth += 1;
                tag.clear();
            }
            '>' => {
                depth = depth.saturating_sub(1);
                // A closing block tag ends a line.
                let t = tag.trim_start_matches('/').to_ascii_lowercase();
                if matches!(t.as_str(), "p" | "h1" | "h2" | "h3" | "li" | "div" | "br") {
                    out.push('\n');
                }
            }
            _ if depth > 0 => tag.push(c),
            _ => out.push(c),
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    // Collapse the blank lines the block boundaries leave behind.
    decoded
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
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
    fresh: State<'_, Arc<crate::kbfresh::KbFreshness>>,
    name: String,
    course: Option<String>,
) -> Notebook {
    let nb = store.create(name, course);
    fresh.touch("scribe");
    nb
}

/// Debounced from the frontend at ~500 ms, so this runs constantly while you
/// write. It only *marks* the source; the rebuild waits for the edits to stop
/// (see `kbfresh`), and skips pages whose mtime hasn't moved.
#[tauri::command]
pub fn scribe_save(
    store: State<'_, ScribeStore>,
    fresh: State<'_, Arc<crate::kbfresh::KbFreshness>>,
    notebook: Notebook,
) {
    store.save(notebook);
    fresh.touch("scribe");
}

#[tauri::command]
pub fn scribe_delete(
    store: State<'_, ScribeStore>,
    fresh: State<'_, Arc<crate::kbfresh::KbFreshness>>,
    id: String,
) {
    store.delete(&id);
    // A deleted notebook must leave the index too, or the agent keeps citing
    // pages that no longer exist.
    fresh.touch("scribe");
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
    fresh: State<'_, Arc<crate::kbfresh::KbFreshness>>,
    id: String,
    page_index: u32,
    note: PageNote,
    png_b64: String,
) -> Result<String, String> {
    let nb = scribe.load(&id).ok_or_else(|| "notebook not found".to_string())?;
    let course = nb.course.clone();
    let location = kb.source_location("onyx");
    let out = tauri::async_runtime::spawn_blocking(move || {
        publish_page(
            location.as_deref(),
            course.as_deref(),
            page_index,
            &note,
            &png_b64,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    // A published page becomes an Onyx note, so the vault's index is stale. The
    // watcher would catch this too, but only if a vault is configured *and*
    // watchable — this path knows for certain that something was written.
    fresh.touch("onyx");
    out
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
    fn page_text_reads_documents_and_legacy_strokes() {
        // v2 document: prose out of the HTML, tags and entities gone.
        let doc = r#"{"v":2,"html":"<h1>KKT</h1><p>Stationarity &amp; slackness</p><ul><li>primal</li></ul>","objects":[]}"#;
        assert_eq!(page_text(doc), "KKT\nStationarity & slackness\nprimal");
        // Pre-document page: typed strokes still index.
        let legacy = r#"[{"t":"pen","pts":[]},{"t":"text","text":"duality gap"}]"#;
        assert_eq!(page_text(legacy), "duality gap\n");
        // A page of pure ink has no text to index, and mustn't invent any.
        assert_eq!(page_text(r#"{"v":2,"html":"","objects":[{"id":"a"}]}"#), "");
        assert_eq!(page_text("not json"), "");
    }

    #[test]
    fn today_ymd_is_well_formed() {
        let d = today_ymd();
        assert_eq!(d.len(), 10);
        assert_eq!(d.as_bytes()[4], b'-');
        assert_eq!(d.as_bytes()[7], b'-');
    }

    #[test]
    fn every_mutation_bumps_the_generation() {
        // The KB indexer decides whether to re-embed by comparing this across
        // ticks. A mutation that fails to bump it leaves those pages invisible to
        // the agent until something unrelated happens to change the store.
        let store = ScribeStore::default();
        let g0 = store.generation();

        let nb = store.create("Calculus".into(), None);
        let g1 = store.generation();
        assert!(g1 > g0, "create bumps");

        store.save(nb.clone());
        let g2 = store.generation();
        assert!(
            g2 > g1,
            "save bumps - the autosave path, and the common one"
        );

        store.delete(&nb.id);
        assert!(store.generation() > g2, "delete bumps");

        // Reads must not bump, or the indexer would re-embed on every tick.
        let g3 = store.generation();
        let _ = store.list();
        let _ = store.load(&nb.id);
        assert_eq!(store.generation(), g3, "reads leave it alone");
    }

    #[test]
    fn page_images_and_fence_stripping() {
        // The v2 doc shape: ink lives in `objects[].src` as data URLs.
        let doc = r#"{"v":2,"html":"<p>hi</p>","objects":[
            {"id":"a","src":"data:image/png;base64,AAAA","x":0,"y":0,"w":10,"h":10},
            {"id":"b","src":"data:image/png;base64,BBBB","x":0,"y":0,"w":10,"h":10}]}"#;
        assert_eq!(page_images(doc), vec!["AAAA", "BBBB"]);

        // A page with only typed text has nothing to transcribe, and the legacy
        // stroke-array format has no objects at all - neither may panic.
        assert!(page_images(r#"{"v":2,"html":"<p>typed</p>","objects":[]}"#).is_empty());
        assert!(page_images("[]").is_empty());
        assert!(page_images("not json").is_empty());
        // A malformed src is skipped rather than yielding a bogus payload.
        assert!(page_images(r#"{"objects":[{"src":"data:image/png,notbase64"}]}"#).is_empty());

        // Models wrap output in fences however firmly the prompt says not to.
        assert_eq!(strip_fences("```latex\nx^2 + y^2\n```"), "x^2 + y^2");
        assert_eq!(strip_fences("```\n\\int f\n```"), "\\int f");
        assert_eq!(strip_fences("  $E=mc^2$  "), "$E=mc^2$");
        // No fence: returned as-is, not mangled.
        assert_eq!(strip_fences("\\[ a+b \\]"), "\\[ a+b \\]");
    }
}

/// A suggested spelling/grammar fix in a page (mirrors the agent's `TextFix` so
/// the frontend gets a bindings type without depending on `flux-agent`).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TextFix {
    pub before: String,
    pub after: String,
    pub why: String,
}

/// Proofread a Scribe page with the local model — spelling, grammar and
/// punctuation only.
///
/// Nothing is applied here: this returns *suggestions*, each one already checked
/// to be a verbatim span of the text that was sent (see `validate_fixes`), and
/// the user accepts or dismisses each in the editor. An empty list is the honest
/// answer both when the writing is clean and when there's no model to ask, so a
/// missing Ollama never looks like a page full of mistakes.
#[tauri::command]
pub async fn scribe_proofread(text: String) -> Result<Vec<TextFix>, String> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let fixes = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_bridge::planner().proofread(&text)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(fixes
        .into_iter()
        .map(|f| TextFix {
            before: f.before,
            after: f.after,
            why: f.why,
        })
        .collect())
}

// ─── Handwriting transcription ───────────────────────────────────────────────
//
// A page of handwritten maths indexes as empty: the ink is a PNG and nothing
// reads it. The local vision model already wired for Lens (`lens.rs`,
// `gemma3:4b` over Ollama) can, and what's wanted out of a maths page is LaTeX
// rather than a plain-text approximation.
//
// The result is stored, never written back into the page. Two reasons: the
// document stays exactly as the user drew it, and — because a model can invent a
// line that was never on the paper — the transcript is indexed under its own KB
// source (`scribe-ocr`) so its machine-read origin travels with every citation
// instead of being indistinguishable from something the user wrote.

/// One transcribed page.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Transcript {
    /// `<notebook id>/<page id>`.
    pub key: String,
    pub notebook: String,
    pub page: String,
    pub title: String,
    pub latex: String,
    /// Which model produced it — provenance, and it changes with the model.
    pub model: String,
    pub ts: u64,
}

#[derive(Default)]
pub struct TranscriptStore {
    items: RwLock<HashMap<String, Transcript>>,
    path: Option<PathBuf>,
    generation: AtomicU64,
}

impl TranscriptStore {
    pub fn restore(path: PathBuf) -> Self {
        let items = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Transcript>>(&s).ok())
            .map(|v| v.into_iter().map(|t| (t.key.clone(), t)).collect())
            .unwrap_or_default();
        Self {
            items: RwLock::new(items),
            path: Some(path),
            generation: AtomicU64::new(0),
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
    pub fn list(&self) -> Vec<Transcript> {
        self.items.read().values().cloned().collect()
    }
    pub fn get(&self, key: &str) -> Option<Transcript> {
        self.items.read().get(key).cloned()
    }
    fn put(&self, t: Transcript) {
        self.items.write().insert(t.key.clone(), t);
        self.generation.fetch_add(1, Ordering::Relaxed);
        if let Some(p) = &self.path {
            let all: Vec<Transcript> = self.items.read().values().cloned().collect();
            crate::persist::save_json(p, &all);
        }
    }
}

/// Every ink image on a page, as base64 PNG payloads (no `data:` prefix).
///
/// Pulled out of the opaque content string the same way `page_text` reads the
/// HTML from it — Rust still doesn't own the format, it just knows these two
/// fields.
pub fn page_images(content_json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content_json) else {
        return Vec::new();
    };
    v.get("objects")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| o.get("src").and_then(|s| s.as_str()))
                .filter_map(|src| src.split_once("base64,").map(|(_, b)| b.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

const LATEX_PROMPT: &str = "Transcribe this handwritten page into LaTeX. Output ONLY the LaTeX \
body — no preamble, no \\documentclass, no code fences, no commentary. Use $...$ for inline maths \
and \\[...\\] for displayed equations. Keep the original line and paragraph structure. Transcribe \
ONLY what is actually written: if a symbol is unreadable, write \\text{[?]} rather than guessing at \
what it probably said. Do not solve, correct, complete or explain anything.";

/// Transcribe a page's handwriting to LaTeX with the local vision model.
///
/// Every ink image on the page is read separately and the results joined: one
/// prompt per drawing keeps each image small enough for a 4B model to read
/// carefully, and a page's drawings are usually separate workings anyway.
#[tauri::command]
pub async fn scribe_transcribe(
    app: tauri::AppHandle,
    store: State<'_, ScribeStore>,
    id: String,
    page_index: usize,
) -> Result<Transcript, String> {
    let nb = store.load(&id).ok_or("notebook not found")?;
    let page = nb.pages.get(page_index).ok_or("no such page")?.clone();
    let images = page_images(&page.strokes);
    if images.is_empty() {
        return Err("nothing handwritten on this page to transcribe".into());
    }

    let mut parts: Vec<String> = Vec::new();
    for img in images {
        // Blocking HTTP to Ollama; off the async runtime's thread.
        let out = tauri::async_runtime::spawn_blocking(move || {
            crate::lens::vision_call(img, Some(LATEX_PROMPT.to_string()))
        })
        .await
        .map_err(|e| e.to_string())??;
        let cleaned = strip_fences(&out);
        if !cleaned.trim().is_empty() {
            parts.push(cleaned);
        }
    }
    let latex = parts.join("\n\n");
    if latex.trim().is_empty() {
        return Err("the model read nothing from this page".into());
    }

    let t = Transcript {
        key: format!("{}/{}", nb.id, page.id),
        notebook: nb.id.clone(),
        page: page.id.clone(),
        title: format!("{} — p{} (transcribed)", nb.name, page_index + 1),
        latex,
        model: std::env::var("FLUX_VISION_MODEL").unwrap_or_else(|_| "gemma3:4b".into()),
        ts: now_ms(),
    };
    if let Some(ts) = app.try_state::<TranscriptStore>() {
        ts.put(t.clone());
    }
    // Transcribed handwriting is its own KB source, and it's the only way a
    // handwritten page becomes answerable at all — so it must reach the index
    // without a manual reindex too.
    if let Some(fresh) = app.try_state::<Arc<crate::kbfresh::KbFreshness>>() {
        fresh.touch("scribe-ocr");
    }
    Ok(t)
}

/// The stored transcript for a page, if it has been transcribed.
#[tauri::command]
pub fn scribe_transcript(
    store: State<'_, TranscriptStore>,
    notebook: String,
    page: String,
) -> Option<Transcript> {
    store.get(&format!("{notebook}/{page}"))
}

/// Models like to wrap output in ```latex fences however firmly you ask them not
/// to. Stripping them here rather than trusting the prompt.
fn strip_fences(s: &str) -> String {
    let t = s.trim();
    let Some(rest) = t.strip_prefix("```") else {
        return t.to_string();
    };
    // Drop the language tag on the opening fence, and the closing fence.
    let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
    rest.trim_end()
        .strip_suffix("```")
        .unwrap_or(rest)
        .trim()
        .to_string()
}
