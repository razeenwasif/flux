# Flux terminal shell integration (OSC 133 prompt marks) — BACKLOG #16.
#
# Loaded automatically via `bash --rcfile` when Flux spawns a bash terminal.
# `--rcfile` REPLACES ~/.bashrc, so we re-source your normal startup files first,
# then install a PROMPT_COMMAND hook that emits OSC 133 around each prompt:
#   ESC ] 133 ; D ; <exit>   — the previous command finished (with its status)
#   ESC ] 133 ; A            — a new prompt starts (its line is marked)
# The embedded terminal reads these to colour each command's gutter bar by exit
# status, jump between prompts (Ctrl+Shift+↑/↓), and copy the last command's
# output (Ctrl+Shift+E). Set FLUX_NO_SHELL_INTEGRATION=1 to disable injection.
#
# To use this with a shell Flux doesn't auto-wrap (zsh, or bash you launch
# yourself), source an equivalent by hand — see docs/shell-integration.md.

# Interactive shells only.
case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null ;;
esac

# Re-source the user's normal config (system-wide first, then per-user).
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"

# Install the OSC 133 hook once.
if [ -z "${FLUX_OSC133:-}" ]; then
  export FLUX_OSC133=1

  # Runs before every prompt: report the just-finished command's exit status (D)
  # then open a new prompt (A). Emitting both here (rather than via PS1) keeps it
  # working even when a theme rewrites PS1 from its own PROMPT_COMMAND.
  __flux_osc133() {
    local __flux_st=$?
    printf '\033]133;D;%s\007\033]133;A\007' "$__flux_st"
  }

  # Prepend our hook so $? is captured before any other PROMPT_COMMAND runs.
  case ";${PROMPT_COMMAND:-};" in
    *";__flux_osc133;"*) ;; # already present
    *) PROMPT_COMMAND="__flux_osc133${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
