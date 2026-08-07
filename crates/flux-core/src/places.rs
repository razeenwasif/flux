//! Named locations the agent can refer to without being given a path (#166).
//!
//! "Save this to Onyx under 00 - Optimization" is how people actually say it.
//! It used to fail two ways: the note planner was shown a flat list of existing
//! *files* and never the vault's folders, so it had nothing to match "00 -
//! Optimization" against; and the file tools only accepted real paths, so
//! `list onyx` meant nothing. Both left the user typing an absolute path they
//! shouldn't have to remember.
//!
//! One list, resolved at call time and used in three places: the note planner's
//! prompt, the agent's system prompt, and path resolution in the file tools.
//! Resolved fresh rather than cached — the vault path is a setting the user can
//! change, and a stale answer here writes a note into the wrong directory.

use serde::Serialize;
use tauri::Manager as _;

/// A folder worth knowing by name.
#[derive(Serialize, Debug, Clone, PartialEq, specta::Type)]
pub struct Place {
    /// What the user (and the model) can call it: `onyx`, `scribe`, `downloads`.
    pub name: String,
    /// Absolute path. Native form on each platform — a WSL path on the Windows
    /// build stays a WSL path, because that is what the file tools bridge to.
    pub path: String,
    /// One line on what lives there, for the model's prompt.
    pub what: String,
    /// Top-level folders inside it. The whole point for the vault: this is what
    /// "under 00 - Optimization" gets matched against.
    pub folders: Vec<String>,
}

/// How many folders to name. A vault with hundreds would otherwise crowd out
/// the rest of the prompt; the list is a hint, not an index.
const MAX_FOLDERS: usize = 40;

/// Top-level directory names inside `root`, sorted, excluding dotfiles.
///
/// `.obsidian`, `.git` and friends are machinery, never somewhere a user means
/// to file a note — and offering them invites the model to pick one.
fn folders_in(root: &std::path::Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.truncate(MAX_FOLDERS);
    names
}

fn home() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(std::path::PathBuf::from)
}

/// Everywhere the agent can be pointed at by name.
///
/// Only places that actually exist are returned: naming a directory that isn't
/// there would have the model confidently write to it and fail, which is worse
/// than not offering it.
pub fn places(app: &tauri::AppHandle, vault_setting: Option<&str>) -> Vec<Place> {
    let mut out = Vec::new();

    if let Some(root) = crate::kb::onyx_vault(vault_setting) {
        out.push(Place {
            name: "onyx".into(),
            what: "the user's Onyx markdown vault — where notes are written".into(),
            folders: folders_in(&root),
            path: root.to_string_lossy().into_owned(),
        });
    }

    if let Some(dir) = app
        .try_state::<crate::scribe::ScribeStore>()
        .and_then(|s| s.dir())
    {
        out.push(Place {
            name: "scribe".into(),
            what: "handwritten Scribe notebooks (one file per notebook)".into(),
            folders: folders_in(&dir),
            path: dir.to_string_lossy().into_owned(),
        });
    }

    if let Some(h) = home() {
        let downloads = h.join("Downloads");
        if downloads.is_dir() {
            out.push(Place {
                name: "downloads".into(),
                what: "where Flux saves downloads and edited PDFs".into(),
                folders: Vec::new(),
                path: downloads.to_string_lossy().into_owned(),
            });
        }
        out.push(Place {
            name: "home".into(),
            what: "the user's home directory".into(),
            folders: Vec::new(),
            path: h.to_string_lossy().into_owned(),
        });
    }

    out.extend(drives());
    out
}

/// Windows drives, named by their letter (#176).
///
/// Without these the agent has no idea the Windows side of the machine exists:
/// it is told about the vault and home and nothing else, so "look in my
/// Documents" on a WSL build means typing `/mnt/c/Users/<you>/Documents` by
/// hand every time. Named, `c/Users/you/Documents` resolves through
/// `expandPlace` like any other place.
///
/// Folders are deliberately **not** listed. A drive root is `$Recycle.Bin`,
/// `Program Files`, `Windows`, `System Volume Information` — noise that would
/// crowd the prompt and invite the model to pick one of them.
///
/// Being named is not the same as being readable: `fsroots` still governs what
/// the agent may open, and drives are outside the default allowance.
fn drives() -> Vec<Place> {
    let mut out = Vec::new();

    // WSL: Windows drives are mounted at /mnt/<letter>. Only ones that are
    // really there and really readable — an empty mount point for a card reader
    // with no card is worse than useless in a prompt.
    #[cfg(not(windows))]
    if crate::files::under_wsl() {
        let Ok(read) = std::fs::read_dir("/mnt") else {
            return out;
        };
        let mut names: Vec<String> = read
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            // A drive letter is one ASCII character. `wsl`, `wslg` and any
            // hand-made mount (`ubuntu_ssd`) are not drives.
            .filter(|n| n.len() == 1 && n.chars().all(|c| c.is_ascii_alphabetic()))
            .filter(|n| std::fs::read_dir(format!("/mnt/{n}")).is_ok())
            .collect();
        names.sort();
        for n in names {
            out.push(Place {
                what: format!("the Windows {} drive", n.to_uppercase()),
                path: format!("/mnt/{n}"),
                name: n,
                folders: Vec::new(),
            });
        }
    }

    // Native Windows: the drive letters are the paths.
    #[cfg(windows)]
    for q in crate::files::quick_locations_drives() {
        if let Some(letter) = q.path.chars().next().filter(|c| c.is_ascii_alphabetic()) {
            out.push(Place {
                name: letter.to_ascii_lowercase().to_string(),
                what: format!("the Windows {} drive", letter.to_ascii_uppercase()),
                path: q.path,
                folders: Vec::new(),
            });
        }
    }

    out
}

/// The named places, for the agent panel's prompt and path resolution.
#[tauri::command]
pub fn agent_places(app: tauri::AppHandle, kb: tauri::State<'_, crate::kb::KbStore>) -> Vec<Place> {
    places(&app, kb.source_location("onyx").as_deref())
}

/// The places block as the model reads it — shared by the note planner and the
/// chat system prompt so they can't describe the same vault differently.
pub fn describe(places: &[Place]) -> String {
    if places.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "Named places (refer to these by name; expand to the path when you need one):\n",
    );
    for p in places {
        s.push_str(&format!("  {} = {}  — {}\n", p.name, p.path, p.what));
        if !p.folders.is_empty() {
            s.push_str(&format!("    folders: {}\n", p.folders.join(", ")));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(name: &str, folders: &[&str]) -> Place {
        Place {
            name: name.into(),
            path: format!("/home/me/{name}"),
            what: "a place".into(),
            folders: folders.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn describe_names_the_folder_the_user_would_say() {
        // The request that prompted this: "save it to onyx under 00 - Optimization".
        // The folder has to appear verbatim, or the model has nothing to match.
        let d = describe(&[place("onyx", &["00 - Optimization", "01 - Analysis"])]);
        assert!(d.contains("onyx = /home/me/onyx"), "{d}");
        assert!(d.contains("00 - Optimization"), "{d}");
    }

    #[test]
    fn describe_is_empty_when_there_is_nothing_to_say() {
        // An empty block would otherwise add a header promising places and then
        // list none, which reads as "you have no vault".
        assert_eq!(describe(&[]), "");
    }

    #[test]
    fn a_place_with_no_folders_omits_the_folder_line() {
        let d = describe(&[place("downloads", &[])]);
        assert!(!d.contains("folders:"), "{d}");
    }

    #[test]
    fn folders_are_sorted_case_insensitively_and_hide_machinery() {
        let dir = std::env::temp_dir().join(format!("flux-places-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for name in ["zebra", "Alpha", ".obsidian", ".git"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        std::fs::write(dir.join("a-file.md"), "x").unwrap();

        let got = folders_in(&dir);
        // Dotfiles are machinery; a file is not a folder.
        assert_eq!(got, vec!["Alpha".to_string(), "zebra".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_directory_yields_nothing_rather_than_erroring() {
        assert!(folders_in(std::path::Path::new("/no/such/vault")).is_empty());
    }
}
