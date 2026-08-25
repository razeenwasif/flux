//! The Windows POSIX shell world — MSYS2 (or Git-for-Windows) bash.
//!
//! Flux's embedded terminal, the agent's one-shot `exec` bridge and the nvim
//! client all have to agree on *which* shell "the shell" means. On Unix that is
//! `$SHELL`. On Windows it used to be `wsl.exe`: a second operating system, which
//! is why the code around it grew a path bridge (`/mnt/c/…`), an env bridge
//! (`WSLENV`) and a `--` argument separator that `wsl.exe` re-parses by its own
//! rules.
//!
//! MSYS2 needs none of that. `bash.exe` is a **native Windows process**, so:
//!
//!   · env vars cross into it like any other child — no `WSLENV` allowlist;
//!   · it takes its normal flags directly — no `wsl.exe -- …` prefix;
//!   · a Windows cwd is just a cwd — no translation to make it valid.
//!
//! What remains is the *reverse* translation, and only for the strings bash reads
//! as paths (`--rcfile`, the dtach socket), plus finding the installation. Both
//! live here so no caller has to guess.
//!
//! # Which root, which MSYSTEM
//!
//! `FLUX_SHELL` wins outright (point it at any bash, or at pwsh to leave this
//! module unused). Otherwise the first candidate root that actually contains
//! `usr\bin\bash.exe` is taken — MSYS2 first, Git-for-Windows last, since the
//! latter ships a deliberately minimal userland.
//!
//! `MSYSTEM` selects the toolchain sub-environment (which `bin` goes on `PATH`).
//! We pick the first one that is actually populated rather than hardcoding
//! MINGW64: an install where only UCRT64 packages were ever pulled has an empty
//! `mingw64\bin`, and defaulting there hands the user a shell that cannot find
//! their compiler.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where an MSYS2 / Git-Bash install is looked for, in order. First hit with a
/// `usr\bin\bash.exe` wins.
const CANDIDATE_ROOTS: &[&str] = &[
    r"C:\msys64",
    r"C:\msys32",
    r"C:\tools\msys64",
    r"C:\Program Files\Git",
    r"C:\Program Files (x86)\Git",
];

/// Sub-environments, most-preferred first. UCRT64 leads because it is MSYS2's
/// own recommended default (modern CRT); MSYS is the fallback, being the runtime
/// environment rather than a toolchain.
const SUBSYSTEMS: &[&str] = &["UCRT64", "MINGW64", "CLANG64", "CLANGARM64", "MINGW32"];

/// The installation root — the directory holding `usr\bin\bash.exe`.
///
/// `FLUX_MSYS_ROOT` overrides the search. A `FLUX_SHELL` pointing at a bash
/// inside an install is also honoured, so setting that one variable moves the
/// whole shell world — rcfile translation included — with it.
pub fn root() -> Option<&'static Path> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        if let Some(r) = std::env::var_os("FLUX_MSYS_ROOT").map(PathBuf::from) {
            if is_root(&r) {
                return Some(r);
            }
        }
        // …\usr\bin\bash.exe → …
        if let Some(sh) = flux_shell() {
            let p = PathBuf::from(&sh);
            if let Some(r) = p.ancestors().nth(3) {
                if is_root(r) {
                    return Some(r.to_path_buf());
                }
            }
        }
        CANDIDATE_ROOTS
            .iter()
            .map(PathBuf::from)
            .find(|p| is_root(p))
    })
    .as_deref()
}

fn is_root(p: &Path) -> bool {
    p.join("usr").join("bin").join("bash.exe").is_file()
}

fn flux_shell() -> Option<String> {
    std::env::var("FLUX_SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Absolute path to the bash that *is* the shell world.
///
/// An explicit `FLUX_SHELL` naming a bash is returned verbatim — including one
/// outside any recognised root — so an unusual install still works.
pub fn bash() -> Option<&'static Path> {
    static BASH: OnceLock<Option<PathBuf>> = OnceLock::new();
    BASH.get_or_init(|| {
        if let Some(sh) = flux_shell() {
            let p = PathBuf::from(&sh);
            if is_bash(&p) && p.is_file() {
                return Some(p);
            }
        }
        root().map(|r| r.join("usr").join("bin").join("bash.exe"))
    })
    .as_deref()
}

fn is_bash(p: &Path) -> bool {
    p.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("bash"))
        .unwrap_or(false)
}

/// The shell world's `$HOME`, as a Windows path — `<root>\home\<user>`.
///
/// MSYS2 keeps a home of its own, separate from `C:\Users\you` (the stock
/// `db_home: cygwin desc` in `nsswitch.conf`). So `~` in a Flux terminal is
/// `/home/you`, and anything on this side that has to agree with the shell about
/// where `~` is — a Terminal tab's saved directory — has to ask here.
///
/// `None` when there's no install, or when the directory doesn't exist yet: the
/// first login shell creates it, and pointing a spawn at a missing directory
/// fails the spawn.
pub fn home() -> Option<PathBuf> {
    let user = std::env::var("USERNAME").ok().filter(|u| !u.is_empty())?;
    let h = root()?.join("home").join(user);
    h.is_dir().then_some(h)
}

/// The `MSYSTEM` to launch under: `FLUX_MSYSTEM`, else the inherited one, else
/// the first sub-environment whose `bin` holds anything at all.
pub fn msystem() -> &'static str {
    static SYS: OnceLock<String> = OnceLock::new();
    SYS.get_or_init(|| {
        for var in ["FLUX_MSYSTEM", "MSYSTEM"] {
            if let Ok(v) = std::env::var(var) {
                let v = v.trim();
                if !v.is_empty() {
                    return v.to_ascii_uppercase();
                }
            }
        }
        let Some(root) = root() else {
            return "MSYS".into();
        };
        SUBSYSTEMS
            .iter()
            .find(|s| {
                let bin = root.join(s.to_ascii_lowercase()).join("bin");
                std::fs::read_dir(&bin)
                    .map(|mut d| d.next().is_some())
                    .unwrap_or(false)
            })
            .map(|s| (*s).to_string())
            .unwrap_or_else(|| "MSYS".into())
    })
}

/// Environment the MSYS2 launcher itself sets, as pairs to apply to a child.
///
/// `MSYS2_PATH_TYPE=inherit` keeps the Windows `PATH` visible inside the shell.
/// That is the WSL behaviour being replaced (interop appended the Windows path),
/// and without it a Flux terminal loses every Windows-installed tool — `flux`
/// itself among them. `FLUX_MSYS_PATH_TYPE=strict` gets the clean MSYS-only path.
///
/// `chere` ("cd here") tells `/etc/profile` **not** to jump to `$HOME`, which is
/// what makes an explicitly-set cwd — a Terminal tab's directory — survive the
/// login shell. Pass `false` for the usual land-in-home behaviour.
pub fn env_pairs(chere: bool) -> Vec<(&'static str, String)> {
    let path_type = std::env::var("FLUX_MSYS_PATH_TYPE")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "inherit".into());
    let mut v = vec![
        ("MSYSTEM", msystem().to_string()),
        ("MSYS2_PATH_TYPE", path_type),
    ];
    if chere {
        v.push(("CHERE_INVOKING", "1".into()));
    }
    v
}

/// Variables to *remove* from a child's environment before launching bash.
///
/// `HOME`: Windows programs (Git-Bash among them) sometimes export `HOME` as a
/// Windows path. Inherited, it would make `~` mean `C:\Users\you` in the terminal
/// while MSYS2's own shortcuts mean `/home/you` — two homes, so two `~/.bashrc`s
/// and two histories. Dropping it lets `/etc/profile` derive the one MSYS2
/// considers correct, exactly as the launcher does.
pub const DROP_VARS: &[&str] = &["HOME"];

/// Apply the shell-world environment to a std `Command`.
pub fn configure(cmd: &mut std::process::Command, chere: bool) {
    for (k, v) in env_pairs(chere) {
        cmd.env(k, v);
    }
    for k in DROP_VARS {
        cmd.env_remove(k);
    }
}

/// A `bash -lc <script>` in the shell world, ready to spawn (no console window).
///
/// `None` when no bash was found — callers fall back to a native Windows shell
/// rather than pretending the command ran.
pub fn login_command(script: &str) -> Option<std::process::Command> {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(bash()?);
    c.args(["-lc", script]);
    configure(&mut c, false);
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Some(c)
}

/// Resolve a program on the shell world's `PATH` to an absolute **Windows** path.
///
/// Two questions in one login shell: does `command -v` find it, and where does
/// that land on the Windows side (`cygpath -w`)? The second half is what lets a
/// caller spawn the program *directly* — no `bash -c` wrapper, so nothing extra
/// appears in its command line, which is what `pkill -f` in `terminal` needs.
///
/// Cached per name, misses included: each answer costs a login shell, and the
/// callers ask on paths where that would otherwise be per terminal or per agent
/// turn. A program installed while Flux is running is picked up on next launch.
pub fn resolve(prog: &str) -> Option<String> {
    static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, Option<String>>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(prog).cloned()) {
        return hit;
    }
    let found = resolve_uncached(prog);
    if let Ok(mut c) = cache.lock() {
        c.insert(prog.to_string(), found.clone());
    }
    found
}

fn resolve_uncached(prog: &str) -> Option<String> {
    // Only ever called with literals from this crate, but a shell word is a shell
    // word: refuse anything that is not a plain program name.
    if prog.is_empty()
        || !prog
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    {
        return None;
    }
    let script = format!("p=$(command -v {prog}) && cygpath -w -- \"$p\"");
    let out = login_command(&script)?.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// `C:\Users\me\x` → `/c/Users/me/x`, for the strings bash reads *as* paths.
///
/// Done in-process rather than by shelling out to `cygpath`: this runs on the
/// terminal-spawn path, where a subprocess per session would be paid for nothing.
/// The drive mapping assumes the default automount root (`/`), which is what
/// every stock install has.
pub fn to_posix(p: &Path) -> String {
    let s = p.to_string_lossy();
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        let drive = (b[0] as char).to_ascii_lowercase();
        format!("/{}{}", drive, s[2..].replace('\\', "/"))
    } else {
        s.replace('\\', "/")
    }
}

/// `/c/Users/me/x` → `C:\Users\me\x`; anything else POSIX-rooted → inside the
/// install (`/home/me` → `C:\msys64\home\me`).
///
/// `/mnt/c/…` and `/cygdrive/c/…` are accepted too — not for compatibility's
/// sake, but because a session saved in the WSL days has `/mnt/c/...` sitting in
/// a Terminal tab's stored directory, and the alternative to translating it is a
/// tab that silently opens somewhere else.
///
/// `None` for a path that is already Windows-shaped or relative, so callers can
/// tell "nothing to do" from a translation.
pub fn to_windows(p: &str) -> Option<PathBuf> {
    let p = p.replace('\\', "/");
    let rest = p.strip_prefix('/')?;
    let rest = rest
        .strip_prefix("mnt/")
        .or_else(|| rest.strip_prefix("cygdrive/"))
        .unwrap_or(rest);
    // A single-letter first segment is a drive: /c, /c/, /c/Users/…
    let (head, tail) = match rest.split_once('/') {
        Some((h, t)) => (h, t),
        None => (rest, ""),
    };
    let head = head.as_bytes();
    if head.len() == 1 && head[0].is_ascii_alphabetic() {
        let drive = head[0].to_ascii_uppercase() as char;
        return Some(PathBuf::from(format!(
            "{drive}:\\{}",
            tail.replace('/', "\\")
        )));
    }
    Some(root()?.join(rest.replace('/', "\\")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_become_posix() {
        assert_eq!(
            to_posix(Path::new(r"C:\Users\me\AppData\flux\rc.bash")),
            "/c/Users/me/AppData/flux/rc.bash"
        );
        // Already POSIX-ish, or a UNC share: only the separators change.
        assert_eq!(to_posix(Path::new(r"\\srv\share\x")), "//srv/share/x");
    }

    #[test]
    fn drive_paths_come_back() {
        assert_eq!(
            to_windows("/c/Users/me"),
            Some(PathBuf::from(r"C:\Users\me"))
        );
        assert_eq!(
            to_windows("/C/Users/me"),
            Some(PathBuf::from(r"C:\Users\me"))
        );
        // The shapes a session saved under WSL left behind.
        assert_eq!(to_windows("/mnt/d/code"), Some(PathBuf::from(r"D:\code")));
        assert_eq!(
            to_windows("/cygdrive/d/code"),
            Some(PathBuf::from(r"D:\code"))
        );
    }

    #[test]
    fn a_windows_path_is_left_alone() {
        assert_eq!(to_windows(r"C:\Users\me"), None);
        assert_eq!(to_windows("relative/bit"), None);
    }

    #[test]
    fn install_relative_paths_need_a_root() {
        // /home/me is inside the install — translatable only if we found one.
        match root() {
            Some(r) => assert_eq!(to_windows("/home/me"), Some(r.join(r"home\me"))),
            None => assert_eq!(to_windows("/home/me"), None),
        }
    }

    #[test]
    fn resolve_rejects_anything_but_a_program_name() {
        for bad in ["", "dtach; rm -rf /", "$(id)", "a b", "../x"] {
            assert_eq!(resolve(bad), None, "{bad:?} is not a program name");
        }
    }
}
