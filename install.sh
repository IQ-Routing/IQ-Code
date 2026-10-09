#!/bin/sh
# IQ Code marketplace installer for macOS, Linux and WSL. Works when piped to sh.
set -eu
umask 077

# Public marketplace repository.
IQ_PUBLIC_REPO='IQ-Routing/IQ-Code'
uninstall=0
purge=0
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    --uninstall) uninstall=1 ;;
    --purge) purge=1 ;;
    -h|--help)
      printf '%s\n' 'Usage: install.sh [--uninstall [--purge]]' 'Installs iq-code@iq-routing through Claude Code. Uninstall keeps ~/.claude/iq unless --purge is given.'
      exit 0 ;;
    *) printf 'install.sh: unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
[ "$purge" -eq 0 ] || [ "$uninstall" -eq 1 ] || die '--purge requires --uninstall'
home_dir=${HOME:-${USERPROFILE:-}}
[ -n "$home_dir" ] || die 'HOME and USERPROFILE are unset; no files were changed'
case "$home_dir" in
  //*) die 'home must be a local absolute path' ;;
  /*) ;;
  *) die 'HOME (or USERPROFILE) must be an absolute path' ;;
esac
[ -d "$home_dir" ] || die 'home directory does not exist'
home_dir=$(cd "$home_dir" && pwd -P)
iq_dir=${home_dir%/}/.claude/iq
plain_path() {
  cursor=$1
  while [ "$cursor" != / ] && [ -n "$cursor" ]; do
    [ ! -L "$cursor" ] || die "refusing a data directory symlink: $cursor"
    if [ -e "$cursor" ]; then [ -d "$cursor" ] || die "not a directory: $cursor"; fi
    cursor=${cursor%/*}
  done
}
plain_path "$iq_dir"
if [ "$uninstall" -eq 0 ]; then
  case "$IQ_PUBLIC_REPO" in
    *'{'*|*'}'*|'') die 'This installer is misconfigured; download it again from iq-routing.com' ;;
  esac
fi
command -v claude >/dev/null 2>&1 || die 'Claude Code 2.1.287+ is required. Install it: https://code.claude.com/docs/en/setup'
version_text=$(claude --version </dev/null) || die 'could not read the Claude Code version'
if ! printf '%s\n' "$version_text" | awk '
  NR == 1 {
    if (!match($0, /^[[:space:]]*v?[0-9]+\.[0-9]+\.[0-9]+([[:space:]]|\+|$)/)) exit 1
    v = substr($0, RSTART, RLENGTH); sub(/^[[:space:]]*v?/, "", v)
    split(v, n, ".")
    exit !(n[1]+0 > 2 || (n[1]+0 == 2 && (n[2]+0 > 1 || (n[2]+0 == 1 && n[3]+0 >= 287))))
  }
  END { if (NR == 0) exit 1 }
'; then
  die 'Claude Code 2.1.287+ is required. Update it: https://code.claude.com/docs/en/setup'
fi

# Read only candidate plugin manifests, never Claude settings or IQ key files.
# Object-depth tokenization avoids mistaking an author named iq for the plugin.
is_iq() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  awk '
    { text = text $0 "\n" }
    END {
      depth = 0; key = ""; value = 0
      for (i = 1; i <= length(text); i++) {
        c = substr(text, i, 1)
        if (c == "\"") {
          token = ""
          for (i++; i <= length(text); i++) {
            c = substr(text, i, 1)
            if (c == "\\") { token = token c substr(text, ++i, 1); continue }
            if (c == "\"") break
            token = token c
          }
          if (depth == 1) {
            if (value && key == "name" && token == "iq") exit 0
            if (!value) key = token
          }
        } else if (c == "{" || c == "[") depth++
        else if (c == "}" || c == "]") depth--
        else if (depth == 1 && c == ":") value = 1
        else if (depth == 1 && c == ",") { value = 0; key = "" }
      }
      exit 1
    }
  ' "$1"
}
shell_quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
remaining=
shadow=0
dirs=${CLAUDE_CODE_PLUGIN_DIRS:-}
while [ -n "$dirs" ]; do
  entry=${dirs%%:*}
  case "$dirs" in *:*) dirs=${dirs#*:} ;; *) dirs= ;; esac
  candidate=$entry
  case "$candidate" in '~') candidate=$home_dir ;; '~/'*) candidate=$home_dir/${candidate#\~/} ;; esac
  case "$candidate" in
    /*) if is_iq "$candidate/.claude-plugin/plugin.json"; then
      shadow=1
      printf 'Warning: legacy local plugin iq at %s would load alongside iq-code and double the hooks.\n' "$entry" >&2
      printf 'Remove this entry from CLAUDE_CODE_PLUGIN_DIRS in your shell startup file or the env block of Claude settings: %s\n' "$entry" >&2
      continue
    fi ;;
  esac
  [ -n "$entry" ] || continue
  remaining=${remaining:+$remaining:}$entry
done
if [ "$shadow" -eq 1 ]; then
  if [ -n "$remaining" ]; then
    printf 'For this shell, run: export CLAUDE_CODE_PLUGIN_DIRS=' >&2
    shell_quote "$remaining" >&2
    printf '\n' >&2
  else
    printf '%s\n' 'For this shell, run: unset CLAUDE_CODE_PLUGIN_DIRS' >&2
  fi
  printf '%s\n' 'Then restart Claude Code. The installer does not edit that variable or your settings.' >&2
fi

# Read from the controlling terminal even when the installer itself is piped.
# No terminal means skip; never consume the rest of a piped installer as a key.
configure_key() {
  if [ -t 0 ]; then
    exec 3<&0
  elif (exec 3<>/dev/tty) 2>/dev/null; then
    exec 3<>/dev/tty
  else
    printf '%s\n' 'Add your IQ key with /plugin configure iq-code@iq-routing, then /reload-plugins.'
    return
  fi
  tty_state=$(stty -g <&3) || die 'could not read terminal settings'
  trap 'stty "$tty_state" <&3; unset iq_key; exec 3>&-' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  stty -echo <&3 || die 'could not hide IQ key input'
  printf '%s' 'IQ key (optional; Enter skips): ' >&2
  iq_key=
  IFS= read -r iq_key <&3 || iq_key=
  stty "$tty_state" <&3
  printf '\n' >&2
  exec 3>&-
  trap - 0 INT TERM HUP
  if [ -z "$iq_key" ]; then
    unset iq_key
    printf '%s\n' 'Add your IQ key with /plugin configure iq-code@iq-routing, then /reload-plugins.'
    return
  fi
  # The shared reader accepts only token characters. Reject before JSON encoding.
  # This also makes printf serialization safe without another runtime dependency.
  if ! printf '%s\n' "$iq_key" | awk 'NR == 1 { ok = length($0) <= 4096 && $0 ~ /^[A-Za-z0-9._~+\/-]+=*$/ } END { exit !(NR == 1 && ok) }'; then
    unset iq_key
    die 'IQ key format is invalid; use /plugin configure iq-code@iq-routing'
  fi
  # Built-in printf sends the value only to a pipe, never to argv or disk.
  if printf '{"iq_api_key":"%s"}\n' "$iq_key" | claude plugin configure iq-code@iq-routing --values-stdin >/dev/null 2>&1; then
    unset iq_key
    printf '%s\n' 'IQ key saved. Apply key changes with /reload-plugins or a restart.'
  else
    unset iq_key
    die 'could not save IQ key; use /plugin configure iq-code@iq-routing'
  fi
}

if [ "$uninstall" -eq 1 ]; then
  claude plugin uninstall iq-code@iq-routing --scope user </dev/null
  if [ "$purge" -eq 1 ]; then
    plain_path "$iq_dir"
    rm -rf -- "$iq_dir"
    printf 'IQ Code uninstalled. Removed %s. The iq-routing marketplace remains registered.\n' "$iq_dir"
  else
    printf 'IQ Code uninstalled. Left %s (IQ settings, logs and any saved key). The iq-routing marketplace remains registered.\n' "$iq_dir"
    printf '%s\n' 'To remove IQ data too, run install.sh --uninstall --purge.'
  fi
  exit 0
fi

mkdir -p "$iq_dir"
plain_path "$iq_dir"
chmod 700 "$iq_dir"
CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1 claude plugin marketplace add "$IQ_PUBLIC_REPO" </dev/null
claude plugin install iq-code@iq-routing --scope user </dev/null
configure_key
printf '%s\n' 'IQ Code installed. Start Claude Code and run /iq.' 'If a session is already open, run /reload-plugins.'
