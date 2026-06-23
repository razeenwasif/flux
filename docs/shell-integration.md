# Terminal shell integration (OSC 133)

Flux's embedded terminal understands the **OSC 133** "semantic prompt" marks that
a shell can emit around each prompt and command. With them, the terminal can:

- **Colour a gutter bar** next to every command — violet while it runs, green on
  success, magenta on a non-zero exit.
- **Jump between prompts** with `Ctrl+Shift+↑` / `Ctrl+Shift+↓`.
- **Copy the last command's output** with `Ctrl+Shift+E`.

These all degrade gracefully: if the shell emits nothing, the terminal behaves
exactly as before.

## bash — automatic

When Flux spawns a **bash** terminal it launches `bash --rcfile <snippet>`, which
re-sources your normal `~/.bashrc` and then installs the marks. Nothing to do.

Disable it with `FLUX_NO_SHELL_INTEGRATION=1` if it ever conflicts with an exotic
prompt setup. (The same snippet lives at
`crates/flux-core/assets/shell-integration.bash`.)

> WSL: Flux runs `wsl.exe -- bash --rcfile …`, so this forces **bash** even if your
> login shell is zsh. Set `FLUX_NO_SHELL_INTEGRATION=1` to keep your default shell,
> then add the zsh snippet below by hand.

## zsh — manual

Add to your `~/.zshrc`:

```zsh
autoload -Uz add-zsh-hook
__flux_osc133_precmd()  { printf '\033]133;D;%s\007\033]133;A\007' "$?"; }
add-zsh-hook precmd __flux_osc133_precmd
```

## PowerShell — manual

Add to your `$PROFILE`:

```powershell
function prompt {
  $code = if ($?) { 0 } else { 1 }
  $osc = [char]27
  $bel = [char]7
  "$osc]133;D;$code$bel$osc]133;A$bel" + "PS " + (Get-Location) + "> "
}
```

## How it works

The hook emits, just before each prompt:

```
ESC ] 133 ; D ; <exit-code> BEL   # the command that just finished
ESC ] 133 ; A               BEL   # a new prompt begins here
```

Flux registers a buffer marker at each `A` (the prompt line) and attaches the
preceding `D`'s exit code to it. Prompt jumping scrolls between the markers;
"copy last output" grabs the lines between the two most recent prompts.
