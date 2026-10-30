//! One list of Flux's commands and their keys (Flux Next "keys", after
//! Zephium's command registry). The menu bar, the launcher's hints, Settings →
//! Keyboard and the chord forwarder in every page (`assets/shortcuts.js`) all
//! read it; the shell runs the commands. Rebinding one saves to `keys.json`
//! and reaches each of them at once.
//!
//! A chord is written `Ctrl+Alt+Shift+Cmd+K`, modifiers in that order (the
//! order macOS shows them in). Defaults say `Mod` for ⌘ on macOS and Ctrl
//! elsewhere; `mac:` or `other:` keeps one to a platform.

use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Command {
    pub id: &'static str,
    /// Settings' name, title-cased for the menu bar unless `menu` says otherwise.
    pub title: &'static str,
    pub detail: &'static str,
    pub group: &'static str,
    pub keys: &'static [&'static str],
    /// Who sets it, when it can't be rebound: "Set by macOS".
    pub fixed: Option<&'static str>,
    /// The menu bar's name for it, when the title doesn't read as one.
    pub menu: Option<&'static str>,
}

const fn c(
    id: &'static str,
    title: &'static str,
    detail: &'static str,
    group: &'static str,
    keys: &'static [&'static str],
) -> Command {
    Command {
        id,
        title,
        detail,
        group,
        keys,
        fixed: None,
        menu: None,
    }
}

const fn fixed(mut cmd: Command, by: &'static str) -> Command {
    cmd.fixed = Some(by);
    cmd
}

const fn menu(mut cmd: Command, title: &'static str) -> Command {
    cmd.menu = Some(title);
    cmd
}

const TABS: &str = "Tabs";
const GO_TO_TAB: &str = "Go to a tab";
const NAV: &str = "Navigation";
const PAGE: &str = "Page";
const PANELS: &str = "Panels";
const TAB_BAR: &str = "Tab bar";
const AGENT: &str = "Agent and notes";
const PAGES: &str = "Flux pages";

#[rustfmt::skip]
pub const COMMANDS: &[Command] = &[
    c("new-tab", "New tab", "Open a tab in this space", TABS, &["Mod+T"]),
    c("new-private", "New private tab", "A tab that keeps no history or cookies", TABS, &["Shift+Mod+N"]),
    c("new-terminal", "New terminal tab", "A shell in a tab of its own", TABS, &[]),
    c("new-files", "New files tab", "Browse your files in a tab", TABS, &[]),
    c("reopen-tab", "Reopen closed tab", "Bring back the last tab you closed", TABS, &["Shift+Mod+T"]),
    fixed(c("close-tab", "Close tab", "Close the tab you're on", TABS, &["Mod+W"]), "Standard in every browser"),
    c("next-tab", "Next tab", "The tab below this one", TABS, &["Ctrl+Tab", "mac:Shift+Cmd+]"]),
    c("prev-tab", "Previous tab", "The tab above this one", TABS, &["Ctrl+Shift+Tab", "mac:Shift+Cmd+["]),
    menu(c("split", "Split with…", "Put another tab beside this one", TABS, &["Shift+Mod+\\"]), "Split With…"),
    c("sleep-bg", "Sleep background tabs", "Free the memory of tabs you aren't using", TABS, &[]),
    c("ws-new", "New workspace", "A space for another set of tabs", TABS, &[]),
    c("ws-rename", "Rename workspace", "Name the space you're in", TABS, &[]),
    c("close-workspace-tabs", "Close all tabs in this workspace", "Asks first", TABS, &[]),
    c("close-all-tabs", "Close every tab", "In every workspace; asks first", TABS, &[]),
    c("tab-1", "Go to tab 1", "The first tab in this space", GO_TO_TAB, &["Mod+1"]),
    c("tab-2", "Go to tab 2", "The second tab", GO_TO_TAB, &["Mod+2"]),
    c("tab-3", "Go to tab 3", "The third tab", GO_TO_TAB, &["Mod+3"]),
    c("tab-4", "Go to tab 4", "The fourth tab", GO_TO_TAB, &["Mod+4"]),
    c("tab-5", "Go to tab 5", "The fifth tab", GO_TO_TAB, &["Mod+5"]),
    c("tab-6", "Go to tab 6", "The sixth tab", GO_TO_TAB, &["Mod+6"]),
    c("tab-7", "Go to tab 7", "The seventh tab", GO_TO_TAB, &["Mod+7"]),
    c("tab-8", "Go to tab 8", "The eighth tab", GO_TO_TAB, &["Mod+8"]),
    c("tab-9", "Go to the last tab", "However many there are", GO_TO_TAB, &["Mod+9"]),
    c("palette", "Launcher", "Search the web, your tabs, history, notes and commands", NAV, &["Mod+K", "Shift+Mod+K"]),
    menu(c("focus-address", "Open location", "Type an address or a search", NAV, &["Mod+L"]), "Open Location…"),
    fixed(c("back", "Back", "The page before this one", NAV, &["mac:Cmd+[", "Alt+ArrowLeft"]), "Standard in every browser"),
    fixed(c("forward", "Forward", "The page after this one", NAV, &["mac:Cmd+]", "Alt+ArrowRight"]), "Standard in every browser"),
    c("home", "Start page", "Go to the new tab page", NAV, &["mac:Shift+Cmd+H", "other:Alt+Home"]),
    c("reload", "Reload page", "Load this page again", NAV, &["Mod+R", "F5"]),
    c("find", "Find in page", "Search this page's text", NAV, &["Mod+F"]),
    c("semantic-find", "Find by meaning", "Search your open tabs by what they say", NAV, &[]),
    menu(c("history", "History", "Every page you've visited", NAV, &["mac:Cmd+Y", "other:Ctrl+H"]), "Show All History"),
    menu(c("bookmarks", "Bookmarks", "Your bookmarks and folders", NAV, &["mac:Alt+Cmd+B"]), "Show Bookmarks"),
    c("bookmark-page", "Bookmark this page", "Add it to your bookmarks, or take it out", PAGE, &["Mod+D"]),
    c("zoom-in", "Zoom in", "Make the page bigger", PAGE, &["Mod+=", "Shift+Mod+="]),
    c("zoom-out", "Zoom out", "Make the page smaller", PAGE, &["Mod+-"]),
    c("zoom-reset", "Actual size", "Back to 100%", PAGE, &["Mod+0"]),
    c("reader", "Reader mode", "The article alone, in clean type", PAGE, &[]),
    c("capture", "Capture page", "A screenshot of the page", PAGE, &[]),
    c("archive-save", "Save for offline", "Keep a copy to read later", PAGE, &[]),
    c("save-to-omni", "Save to Omni", "Add the page to your Omni index", PAGE, &["Shift+Mod+O"]),
    c("translate", "Translate page", "Into your language", PAGE, &[]),
    c("install-app", "Install as app", "Open this site in a window of its own", PAGE, &[]),
    c("lens", "Identify page", "Ask the agent what's on this page (Lens)", PAGE, &[]),
    fixed(c("devtools", "Web inspector", "Inspect the page's code", PAGE, &["mac:Alt+Cmd+I", "F12"]), "Set by WebKit"),
    c("toggle-sidebar", "Toggle tabs pane", "Show or fold the tabs pane", PANELS, &["Mod+B"]),
    c("toggle-terminal", "Toggle terminal", "Show or hide the terminal drawer", PANELS, &["Mod+`"]),
    c("toggle-agent", "Toggle agent", "Show or hide the agent column", PANELS, &["Shift+Mod+A"]),
    c("toggle-editor", "Toggle editor", "Show or hide the editor column", PANELS, &["Shift+Mod+E"]),
    c("focus-mode", "Focus mode", "Hide everything but the page; Esc brings it back", PANELS, &["Shift+Mod+F"]),
    c("bookmark-bar", "Toggle bookmark bar", "Show or hide the bookmark bar", PANELS, &[]),
    c("pages-bar", "Toggle launcher column", "Show or hide the launcher column", PANELS, &[]),
    c("app-dock", "Toggle app dock", "Expand or collapse the app dock", PANELS, &[]),
    c("connect-rail", "Toggle connections rail", "Show or hide the connections rail", PANELS, &[]),
    c("dock-col", "Toggle calendar and mail", "Show or hide the calendar and mail column", PANELS, &[]),
    c("mode-tabs", "Show tabs", "The tabs pane's tab list", TAB_BAR, &["Alt+1"]),
    c("mode-calendar", "Show calendar", "The month and the day's events", TAB_BAR, &["Alt+2"]),
    c("mode-mail", "Show mail", "Your inbox, read-only", TAB_BAR, &["Alt+3"]),
    c("mode-notes", "Show notes", "Your notes and to-dos", TAB_BAR, &["Alt+4"]),
    c("mode-context", "Show context", "Your notes, the system and the Trail", TAB_BAR, &["Alt+5"]),
    c("indexer-ask", "Ask your notes", "The Indexer answers from your notes", AGENT, &[]),
    c("notebook", "Notebook", "Ask your knowledge base", AGENT, &[]),
    c("shell-history", "Shell history", "Search commands you've run, by meaning", AGENT, &["Shift+Mod+R"]),
    c("watches", "Watched pages", "Pages Flux checks for changes", AGENT, &[]),
    c("tracker-graph", "Tracker graph", "The trackers on your pages", AGENT, &[]),
    c("tasks", "Tasks", "Your to-dos", PAGES, &[]),
    menu(c("time-focus", "Time and focus", "Where the time went, and focus sessions", PAGES, &[]), "Time and Focus"),
    c("calendar", "Calendar", "Today and what's coming", PAGES, &[]),
    menu(c("settings", "Settings", "Everything Flux lets you change", PAGES, &["Mod+,"]), "Settings…"),
    c("sessions", "Sessions", "Sets of tabs you saved", PAGES, &[]),
    c("passwords", "Passwords", "The password vault", PAGES, &[]),
    c("omni", "Omni index", "Everything you saved to Omni", PAGES, &[]),
    c("trail", "Trail", "Your browsing as a graph", PAGES, &[]),
    c("archive", "Archive", "Pages you saved for offline", PAGES, &[]),
    c("feeds", "Feeds", "Your RSS reader", PAGES, &[]),
    c("resources", "Resource monitor", "What Flux is using", PAGES, &[]),
    c("activity", "Activity", "Processes and memory", PAGES, &[]),
    c("speedtest", "Speed test", "How fast your network is", PAGES, &[]),
    c("permissions", "Site permissions", "What each site may use", PAGES, &[]),
    c("sentinel", "Agent activity log", "What the agent did, and why", PAGES, &[]),
    c("sync", "Sync", "Encrypted, across your devices", PAGES, &[]),
    c("apps", "Installed apps", "Sites you installed as apps", PAGES, &[]),
    c("discord", "Discord panel", "Discord beside the page", PAGES, &[]),
    c("teams", "Teams panel", "Teams beside the page", PAGES, &[]),
    menu(c("import-browsers", "Import from another browser", "Bookmarks, history and pinned sites", PAGES, &[]), "Import from Another Browser…"),
    menu(c("welcome", "Welcome to Flux", "The six steps of setup, again", PAGES, &[]), "Welcome to Flux…"),
];

/// Chords the system or the Edit menu owns, for telling a clash apart from a
/// rebind. Written for macOS; elsewhere only the Edit ones apply, on Ctrl.
const RESERVED: &[(&str, &str, bool)] = &[
    ("Cmd+Q", "Quit Flux", false),
    ("Cmd+H", "Hide Flux", false),
    ("Alt+Cmd+H", "Hide others", false),
    ("Cmd+M", "Minimize", false),
    ("Cmd+Z", "Undo", true),
    ("Shift+Cmd+Z", "Redo", true),
    ("Cmd+X", "Cut", true),
    ("Cmd+C", "Copy", true),
    ("Cmd+V", "Paste", true),
    ("Cmd+A", "Select all", true),
    ("Ctrl+Cmd+F", "Full screen", false),
    ("Cmd+Tab", "Switch apps", false),
    ("Cmd+Space", "Spotlight", false),
];

const MAC: bool = cfg!(target_os = "macos");

const KEYS: &[&str] = &[
    "Tab",
    "Space",
    "Enter",
    "Backspace",
    "Delete",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
];
const PUNCT: &str = "`-=[]\\;',./";

fn valid_key(k: &str) -> bool {
    let one = k.chars().count() == 1
        && k.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || PUNCT.contains(c));
    let f = k
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n));
    one || f || KEYS.contains(&k)
}

/// `chord` in the canonical form, `Mod` read for this platform; `None` when it
/// isn't one Flux can bind: no modifier but an F-key, Shift alone on a key that
/// types, Esc.
pub fn canonical(chord: &str) -> Option<String> {
    canonical_for(chord, MAC)
}

fn canonical_for(chord: &str, mac: bool) -> Option<String> {
    let (mut ctrl, mut alt, mut shift, mut cmd) = (false, false, false, false);
    // `+` is never a key here (Shift+= is), so the last part is the key.
    let parts: Vec<&str> = chord.split('+').map(str::trim).collect();
    let (key, mods) = parts.split_last()?;
    for m in mods {
        match *m {
            "Ctrl" => ctrl = true,
            "Alt" => alt = true,
            "Shift" => shift = true,
            "Cmd" => cmd = true,
            "Mod" if mac => cmd = true,
            "Mod" => ctrl = true,
            _ => return None,
        }
    }
    let key = if key.chars().count() == 1 {
        key.to_ascii_uppercase()
    } else {
        key.to_string()
    };
    if !valid_key(&key) {
        return None;
    }
    let fkey = key.starts_with('F') && key.len() > 1;
    if !(ctrl || alt || cmd || fkey) {
        return None;
    }
    let mut out = String::new();
    for (on, name) in [(ctrl, "Ctrl"), (alt, "Alt"), (shift, "Shift"), (cmd, "Cmd")] {
        if on {
            out.push_str(name);
            out.push('+');
        }
    }
    out.push_str(&key);
    Some(out)
}

/// The command's default chords on this platform.
fn defaults_for(cmd: &Command, mac: bool) -> Vec<String> {
    cmd.keys
        .iter()
        .filter_map(
            |k| match (k.strip_prefix("mac:"), k.strip_prefix("other:")) {
                (Some(k), _) => mac.then_some(k),
                (_, Some(k)) => (!mac).then_some(k),
                _ => Some(*k),
            },
        )
        .filter_map(|k| canonical_for(k, mac))
        .collect()
}

pub fn command(id: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.id == id)
}

/// "⌘⇧K" on macOS, "Ctrl+Shift+K" elsewhere.
pub fn label(chord: &str) -> String {
    if !MAC {
        return chord.replace("Cmd+", "Win+");
    }
    let mut out = String::new();
    let parts: Vec<&str> = chord.split('+').collect();
    let (key, mods) = parts.split_last().unwrap_or((&"", &[]));
    for m in mods {
        out.push_str(match *m {
            "Ctrl" => "⌃",
            "Alt" => "⌥",
            "Shift" => "⇧",
            _ => "⌘",
        });
    }
    out.push_str(match *key {
        "ArrowLeft" => "←",
        "ArrowRight" => "→",
        "ArrowUp" => "↑",
        "ArrowDown" => "↓",
        "Tab" => "⇥",
        "Enter" => "↩",
        "Backspace" => "⌫",
        "Delete" => "⌦",
        k => k,
    });
    out
}

/// Title case for the menu bar: "Reopen Closed Tab", "Go to the Last Tab".
fn menu_title(cmd: &Command) -> String {
    if let Some(m) = cmd.menu {
        return m.to_string();
    }
    const SMALL: &[&str] = &[
        "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or",
        "the", "to", "with",
    ];
    let words: Vec<&str> = cmd.title.split(' ').collect();
    let last = words.len().saturating_sub(1);
    words
        .iter()
        .enumerate()
        .map(|(i, w)| {
            if i > 0 && i < last && SMALL.contains(w) {
                w.to_string()
            } else {
                let mut cs = w.chars();
                cs.next()
                    .map(|f| f.to_uppercase().chain(cs).collect())
                    .unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A command as the shell shows it.
#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct KeyCommand {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub group: String,
    /// What it's bound to now; the first is the one the menu shows.
    pub keys: Vec<String>,
    pub defaults: Vec<String>,
    pub fixed: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct ReservedKey {
    pub chord: String,
    pub owner: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, specta::Type)]
pub struct KeysInfo {
    pub commands: Vec<KeyCommand>,
    /// Chords the system owns, which no command can take.
    pub reserved: Vec<ReservedKey>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Stored {
    /// Command → its chords, for the commands rebound or cleared (empty).
    keys: BTreeMap<String, Vec<String>>,
}

pub struct KeyStore {
    path: Option<PathBuf>,
    rebound: Mutex<BTreeMap<String, Vec<String>>>,
    mac: bool,
}

impl KeyStore {
    pub fn load(path: Option<PathBuf>) -> Self {
        let stored: Stored = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let store = Self {
            path,
            rebound: Mutex::new(BTreeMap::new()),
            mac: MAC,
        };
        // Keep what still names a command and a chord, as it would be bound now.
        let mut rebound = store.rebound.lock();
        for (id, keys) in stored.keys {
            if command(&id).is_some_and(|c| c.fixed.is_none()) {
                let keys = keys.iter().filter_map(|k| canonical_for(k, MAC)).collect();
                rebound.insert(id, keys);
            }
        }
        drop(rebound);
        store
    }

    fn keys_of(&self, rebound: &BTreeMap<String, Vec<String>>, cmd: &Command) -> Vec<String> {
        rebound
            .get(cmd.id)
            .cloned()
            .unwrap_or_else(|| defaults_for(cmd, self.mac))
    }

    pub fn info(&self) -> KeysInfo {
        let rebound = self.rebound.lock();
        KeysInfo {
            commands: COMMANDS
                .iter()
                .map(|c| KeyCommand {
                    id: c.id.into(),
                    title: c.title.into(),
                    detail: c.detail.into(),
                    group: c.group.into(),
                    keys: self.keys_of(&rebound, c),
                    defaults: defaults_for(c, self.mac),
                    fixed: c.fixed.map(String::from),
                })
                .collect(),
            reserved: self.reserved(),
        }
    }

    fn reserved(&self) -> Vec<ReservedKey> {
        RESERVED
            .iter()
            .filter(|(_, _, everywhere)| self.mac || *everywhere)
            .filter_map(|(k, owner, _)| {
                let chord = if self.mac {
                    k.to_string()
                } else {
                    canonical_for(&k.replace("Cmd", "Ctrl"), false)?
                };
                Some(ReservedKey {
                    chord,
                    owner: owner.to_string(),
                })
            })
            .collect()
    }

    /// Chord → command, for everything bound.
    pub fn map(&self) -> BTreeMap<String, String> {
        let rebound = self.rebound.lock();
        let mut out = BTreeMap::new();
        for c in COMMANDS {
            for k in self.keys_of(&rebound, c) {
                out.entry(k).or_insert_with(|| c.id.to_string());
            }
        }
        out
    }

    pub fn map_json(&self) -> String {
        serde_json::to_string(&self.map()).unwrap_or_else(|_| "{}".into())
    }

    /// A command a key is bound to: what a page may ask the chrome to run.
    pub fn is_bound(&self, id: &str) -> bool {
        let rebound = self.rebound.lock();
        command(id).is_some_and(|c| !self.keys_of(&rebound, c).is_empty())
    }

    /// The menu's chord for a command: its first with ⌘ in it. A menu key
    /// without one would be checked before a text field gets the key.
    fn menu_key(&self, cmd: &Command) -> Option<String> {
        let rebound = self.rebound.lock();
        self.keys_of(&rebound, cmd)
            .into_iter()
            .find(|k| k.contains("Cmd+"))
    }

    /// Bind `id` to `chord` alone (`None` unbinds it). The chord leaves any
    /// other command that had it: the shell has asked ("Use here").
    pub fn set(&self, id: &str, chord: Option<&str>) -> Result<(), String> {
        let cmd = command(id).ok_or_else(|| format!("no command {id}"))?;
        if let Some(by) = cmd.fixed {
            return Err(format!(
                "{} can't be changed: {}",
                cmd.title,
                by.to_lowercase()
            ));
        }
        let mut rebound = self.rebound.lock();
        let keys = match chord {
            None => Vec::new(),
            Some(raw) => {
                let k = canonical_for(raw, self.mac)
                    .ok_or_else(|| format!("{raw} isn't a shortcut Flux can use"))?;
                if let Some(r) = self.reserved().into_iter().find(|r| r.chord == k) {
                    return Err(format!(
                        "{} is {}, which the system owns",
                        label(&k),
                        r.owner
                    ));
                }
                for other in COMMANDS.iter().filter(|o| o.id != id) {
                    let theirs = self.keys_of(&rebound, other);
                    if !theirs.contains(&k) {
                        continue;
                    }
                    if other.fixed.is_some() {
                        return Err(format!(
                            "{} is {}, which can't be changed",
                            label(&k),
                            other.title
                        ));
                    }
                    let left: Vec<String> = theirs.into_iter().filter(|t| *t != k).collect();
                    Self::put(&mut rebound, other, left, self.mac);
                }
                vec![k]
            }
        };
        Self::put(&mut rebound, cmd, keys, self.mac);
        self.save(&rebound);
        Ok(())
    }

    /// Back to the defaults: one command, or all of them.
    pub fn reset(&self, id: Option<&str>) {
        let mut rebound = self.rebound.lock();
        match id {
            Some(id) => {
                rebound.remove(id);
            }
            None => rebound.clear(),
        }
        // A default may now be on two commands; the reset one keeps it.
        if let Some(cmd) = id.and_then(command) {
            for k in defaults_for(cmd, self.mac) {
                for other in COMMANDS.iter().filter(|o| o.id != cmd.id) {
                    let theirs = self.keys_of(&rebound, other);
                    if theirs.contains(&k) {
                        let left = theirs.into_iter().filter(|t| *t != k).collect();
                        Self::put(&mut rebound, other, left, self.mac);
                    }
                }
            }
        }
        self.save(&rebound);
    }

    fn put(
        rebound: &mut BTreeMap<String, Vec<String>>,
        cmd: &Command,
        keys: Vec<String>,
        mac: bool,
    ) {
        if keys == defaults_for(cmd, mac) {
            rebound.remove(cmd.id);
        } else {
            rebound.insert(cmd.id.to_string(), keys);
        }
    }

    fn save(&self, rebound: &BTreeMap<String, Vec<String>>) {
        if let Some(path) = &self.path {
            let stored = Stored {
                keys: rebound.clone(),
            };
            crate::persist::queue_json(path, &stored, crate::persist::Durability::Barrier);
        }
    }
}

/// What's in the menu bar, beyond the system's own items.
#[cfg(target_os = "macos")]
mod menubar {
    use super::{command, menu_title, KeyStore};
    use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Runtime};

    enum Item {
        C(&'static str),
        Sep,
        About,
        Services,
        Hide,
        HideOthers,
        ShowAll,
        Quit,
        Undo,
        Redo,
        Cut,
        Copy,
        Paste,
        SelectAll,
        Minimize,
        Zoom,
    }
    use Item::*;

    const MENUS: &[(&str, &[Item])] = &[
        (
            "Flux",
            &[
                About,
                Sep,
                C("settings"),
                Sep,
                Services,
                Sep,
                Hide,
                HideOthers,
                ShowAll,
                Sep,
                Quit,
            ],
        ),
        (
            "File",
            &[
                C("new-tab"),
                C("new-private"),
                C("new-terminal"),
                C("new-files"),
                C("ws-new"),
                Sep,
                C("import-browsers"),
                Sep,
                C("focus-address"),
                C("reopen-tab"),
                Sep,
                C("close-tab"),
                Sep,
                C("archive-save"),
                C("save-to-omni"),
                C("capture"),
                C("install-app"),
            ],
        ),
        (
            "Edit",
            &[
                Undo,
                Redo,
                Sep,
                Cut,
                Copy,
                Paste,
                SelectAll,
                Sep,
                C("find"),
                C("semantic-find"),
            ],
        ),
        (
            "View",
            &[
                C("toggle-sidebar"),
                C("toggle-terminal"),
                C("toggle-agent"),
                C("toggle-editor"),
                C("focus-mode"),
                Sep,
                C("mode-tabs"),
                C("mode-calendar"),
                C("mode-mail"),
                C("mode-notes"),
                C("mode-context"),
                Sep,
                C("reader"),
                C("reload"),
                Sep,
                C("zoom-in"),
                C("zoom-out"),
                C("zoom-reset"),
                Sep,
                C("devtools"),
                // macOS puts Enter Full Screen in a menu named View itself.
            ],
        ),
        (
            "History",
            &[
                C("back"),
                C("forward"),
                C("home"),
                Sep,
                C("history"),
                C("shell-history"),
            ],
        ),
        (
            "Bookmarks",
            &[C("bookmark-page"), C("bookmarks"), C("bookmark-bar")],
        ),
        (
            "Go",
            &[
                C("palette"),
                Sep,
                C("tasks"),
                C("time-focus"),
                C("calendar"),
                C("notebook"),
                C("indexer-ask"),
                Sep,
                C("passwords"),
                C("archive"),
                C("feeds"),
                C("trail"),
            ],
        ),
        (
            "Window",
            &[
                Minimize,
                Zoom,
                Sep,
                C("next-tab"),
                C("prev-tab"),
                C("split"),
            ],
        ),
    ];

    pub(super) fn build<R: Runtime>(app: &AppHandle<R>, keys: &KeyStore) -> tauri::Result<Menu<R>> {
        let bar = Menu::new(app)?;
        for (title, items) in MENUS {
            let sub = Submenu::new(app, *title, true)?;
            for item in *items {
                let kind: MenuItemKind<R> = match item {
                    C(id) => {
                        let Some(cmd) = command(id) else { continue };
                        // Every chord canonical() makes is a key muda's
                        // accelerator parser knows ("\\" included).
                        let accel = keys.menu_key(cmd);
                        MenuItemKind::MenuItem(MenuItem::with_id(
                            app,
                            cmd.id,
                            menu_title(cmd),
                            true,
                            accel.as_deref(),
                        )?)
                    }
                    Sep => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
                    About => MenuItemKind::Predefined(PredefinedMenuItem::about(
                        app,
                        Some("About Flux"),
                        Some(AboutMetadata {
                            name: Some("Flux".into()),
                            version: Some(env!("CARGO_PKG_VERSION").into()),
                            ..Default::default()
                        }),
                    )?),
                    Services => MenuItemKind::Predefined(PredefinedMenuItem::services(app, None)?),
                    Hide => {
                        MenuItemKind::Predefined(PredefinedMenuItem::hide(app, Some("Hide Flux"))?)
                    }
                    HideOthers => {
                        MenuItemKind::Predefined(PredefinedMenuItem::hide_others(app, None)?)
                    }
                    ShowAll => MenuItemKind::Predefined(PredefinedMenuItem::show_all(app, None)?),
                    Quit => {
                        MenuItemKind::Predefined(PredefinedMenuItem::quit(app, Some("Quit Flux"))?)
                    }
                    Undo => MenuItemKind::Predefined(PredefinedMenuItem::undo(app, None)?),
                    Redo => MenuItemKind::Predefined(PredefinedMenuItem::redo(app, None)?),
                    Cut => MenuItemKind::Predefined(PredefinedMenuItem::cut(app, None)?),
                    Copy => MenuItemKind::Predefined(PredefinedMenuItem::copy(app, None)?),
                    Paste => MenuItemKind::Predefined(PredefinedMenuItem::paste(app, None)?),
                    SelectAll => {
                        MenuItemKind::Predefined(PredefinedMenuItem::select_all(app, None)?)
                    }
                    Minimize => MenuItemKind::Predefined(PredefinedMenuItem::minimize(app, None)?),
                    Zoom => MenuItemKind::Predefined(PredefinedMenuItem::maximize(app, None)?),
                };
                sub.append(&kind)?;
            }
            if *title == "Window" {
                sub.set_as_windows_menu_for_nsapp()?;
            }
            bar.append(&sub)?;
        }
        Ok(bar)
    }

    /// Every command the menu bar names, for the tests.
    #[cfg(test)]
    pub(super) fn ids() -> Vec<&'static str> {
        MENUS
            .iter()
            .flat_map(|(_, items)| items.iter())
            .filter_map(|i| match i {
                C(id) => Some(*id),
                _ => None,
            })
            .collect()
    }
}

/// Put the menu bar up (macOS), and run a command picked from it.
pub fn install_menu(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Some(keys) = app.try_state::<KeyStore>() {
            match menubar::build(app, &keys) {
                Ok(m) => {
                    let _ = app.set_menu(m);
                }
                Err(e) => tracing::warn!(target: "flux::keys", "menu bar: {e}"),
            }
        }
        app.on_menu_event(|app, ev| {
            let id = ev.id().as_ref();
            if command(id).is_some() {
                let _ = app.emit("flux://shortcut", id);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// After a rebind: the menu bar, every page's chord map, and the shell.
fn apply(app: &AppHandle, keys: &KeyStore) {
    #[cfg(target_os = "macos")]
    match menubar::build(app, keys) {
        Ok(m) => {
            let _ = app.set_menu(m);
        }
        Err(e) => tracing::warn!(target: "flux::keys", "menu bar: {e}"),
    }
    let js = format!(
        "window.__fluxKeysSet&&window.__fluxKeysSet({})",
        keys.map_json()
    );
    for (label, wv) in app.webviews() {
        if label.starts_with("tab-") || label.starts_with("panel-") {
            let _ = wv.eval(&js);
        }
    }
    let _ = app.emit("flux://keys", keys.info());
}

#[tauri::command]
pub fn keys_list(keys: State<'_, KeyStore>) -> KeysInfo {
    keys.info()
}

#[tauri::command]
pub fn keys_set(
    app: AppHandle,
    keys: State<'_, KeyStore>,
    id: String,
    chord: Option<String>,
) -> Result<KeysInfo, String> {
    keys.set(&id, chord.as_deref())?;
    apply(&app, &keys);
    Ok(keys.info())
}

#[tauri::command]
pub fn keys_reset(app: AppHandle, keys: State<'_, KeyStore>, id: Option<String>) -> KeysInfo {
    keys.reset(id.as_deref());
    apply(&app, &keys);
    keys.info()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(mac: bool) -> KeyStore {
        KeyStore {
            path: None,
            rebound: Mutex::new(BTreeMap::new()),
            mac,
        }
    }

    #[test]
    fn chords_read_one_way() {
        assert_eq!(
            canonical_for("Mod+Shift+k", true).as_deref(),
            Some("Shift+Cmd+K")
        );
        assert_eq!(
            canonical_for("Shift+Mod+K", false).as_deref(),
            Some("Ctrl+Shift+K")
        );
        assert_eq!(
            canonical_for("Cmd+Alt+Ctrl+Shift+F5", true).as_deref(),
            Some("Ctrl+Alt+Shift+Cmd+F5")
        );
        assert_eq!(canonical_for("Mod+\\", true).as_deref(), Some("Cmd+\\"));
        assert_eq!(canonical_for("F12", true).as_deref(), Some("F12"));
        // Typing keys need a modifier that doesn't type, and Esc is never one.
        assert_eq!(canonical_for("K", true), None);
        assert_eq!(canonical_for("Shift+K", true), None);
        assert_eq!(canonical_for("Cmd+Escape", true), None);
        assert_eq!(canonical_for("Cmd+Hyper+K", true), None);
    }

    #[test]
    fn each_command_once_and_defaults_unique_on_each_platform() {
        let mut ids: Vec<_> = COMMANDS.iter().map(|c| c.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), COMMANDS.len(), "a command id appears twice");
        for mac in [true, false] {
            let mut seen = BTreeMap::new();
            for c in COMMANDS {
                // Every written default parses on the platforms it's for.
                let elsewhere =
                    |k: &&&str| (k.starts_with("mac:") && !mac) || (k.starts_with("other:") && mac);
                let written = c.keys.iter().filter(|k| !elsewhere(k)).count();
                assert_eq!(
                    defaults_for(c, mac).len(),
                    written,
                    "{}: a default doesn't parse",
                    c.id
                );
                for k in defaults_for(c, mac) {
                    if let Some(prev) = seen.insert(k.clone(), c.id) {
                        panic!(
                            "{k} is the default for both {prev} and {} (mac: {mac})",
                            c.id
                        );
                    }
                }
            }
            let s = store(mac);
            for r in s.reserved() {
                assert!(
                    !seen.contains_key(&r.chord),
                    "{} is reserved for {}",
                    r.chord,
                    r.owner
                );
            }
        }
    }

    #[test]
    fn rebinding_moves_a_chord_and_unbinding_clears_it() {
        let s = store(true);
        assert_eq!(
            s.map().get("Shift+Cmd+K").map(String::as_str),
            Some("palette")
        );
        // "Use here": ⌘⇧K goes to Tasks and leaves the launcher with ⌘K.
        s.set("tasks", Some("Mod+Shift+K")).unwrap();
        let info = s.info();
        let keys = |id: &str| {
            info.commands
                .iter()
                .find(|c| c.id == id)
                .unwrap()
                .keys
                .clone()
        };
        assert_eq!(keys("tasks"), vec!["Shift+Cmd+K"]);
        assert_eq!(keys("palette"), vec!["Cmd+K"]);
        assert!(s.is_bound("tasks"));
        s.set("tasks", None).unwrap();
        assert!(!s.is_bound("tasks"));
        assert!(!s.map().contains_key("Shift+Cmd+K"));
        // Back to the defaults: the launcher has both again.
        s.reset(Some("palette"));
        assert_eq!(
            s.map().get("Shift+Cmd+K").map(String::as_str),
            Some("palette")
        );
    }

    #[test]
    fn fixed_and_system_chords_stay_put() {
        let s = store(true);
        assert!(s.set("close-tab", Some("Cmd+J")).is_err());
        let e = s.set("tasks", Some("Cmd+Q")).unwrap_err();
        assert!(e.contains("Quit Flux"), "{e}");
        let e = s.set("tasks", Some("Cmd+W")).unwrap_err();
        assert!(e.contains("Close tab"), "{e}");
        assert!(s.set("tasks", Some("K")).is_err());
        assert!(s.is_bound("close-tab"));
    }

    #[test]
    fn resetting_one_takes_its_default_back() {
        let s = store(true);
        s.set("tasks", Some("Cmd+T")).unwrap();
        assert!(!s.is_bound("new-tab"));
        s.reset(Some("new-tab"));
        assert_eq!(s.map().get("Cmd+T").map(String::as_str), Some("new-tab"));
        assert!(!s.is_bound("tasks"));
    }

    #[test]
    fn saved_keys_load_back_and_bad_ones_drop() {
        let dir = std::env::temp_dir().join(format!("flux-keys-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        std::fs::write(
            &path,
            r#"{"keys":{"tasks":["Cmd+Shift+J"],"close-tab":["Cmd+J"],"gone":["Cmd+G"],"reader":["nonsense"]}}"#,
        )
        .unwrap();
        let s = KeyStore::load(Some(path));
        let map = s.map();
        if MAC {
            assert_eq!(map.get("Shift+Cmd+J").map(String::as_str), Some("tasks"));
            assert_eq!(map.get("Cmd+W").map(String::as_str), Some("close-tab"));
        }
        assert!(!s.is_bound("reader"));
        assert!(command("gone").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_and_menu_titles() {
        if MAC {
            assert_eq!(label("Shift+Cmd+K"), "⇧⌘K");
            assert_eq!(label("Ctrl+Shift+Tab"), "⌃⇧⇥");
            assert_eq!(label("Alt+ArrowLeft"), "⌥←");
        }
        assert_eq!(
            menu_title(command("reopen-tab").unwrap()),
            "Reopen Closed Tab"
        );
        assert_eq!(menu_title(command("tab-9").unwrap()), "Go to the Last Tab");
        assert_eq!(menu_title(command("history").unwrap()), "Show All History");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_menu_bar_names_real_commands_once_and_keys_need_cmd() {
        let ids = menubar::ids();
        for id in &ids {
            assert!(
                command(id).is_some(),
                "the menu names {id}, which isn't a command"
            );
        }
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "a command is in the menu twice");
        let s = store(true);
        assert_eq!(
            s.menu_key(command("next-tab").unwrap()).as_deref(),
            Some("Shift+Cmd+]")
        );
        assert_eq!(s.menu_key(command("mode-tabs").unwrap()), None);
    }

    /// The preview's mock answers keys_list from this (macOS, defaults).
    #[test]
    fn mock_keys_up_to_date() {
        const PATH: &str = "../../apps/shell/src/mock/keys.gen.json";
        let s = store(true);
        let mut info = s.info();
        // Defaults as macOS reads them, wherever the test runs.
        for c in &mut info.commands {
            let cmd = command(&c.id).unwrap();
            c.keys = defaults_for(cmd, true);
            c.defaults = c.keys.clone();
        }
        info.reserved = RESERVED
            .iter()
            .map(|(k, o, _)| ReservedKey {
                chord: k.to_string(),
                owner: o.to_string(),
            })
            .collect();
        let json = serde_json::to_string_pretty(&info).unwrap() + "\n";
        if std::env::var("FLUX_WRITE_BINDINGS").is_ok() {
            std::fs::write(PATH, &json).expect("write mock keys");
            return;
        }
        let existing = std::fs::read_to_string(PATH).unwrap_or_default();
        assert_eq!(
            existing.replace("\r\n", "\n"),
            json,
            "mock/keys.gen.json is stale — run `FLUX_WRITE_BINDINGS=1 cargo test -p flux-core keys`"
        );
    }
}
