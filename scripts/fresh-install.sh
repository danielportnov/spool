#!/usr/bin/env bash
# Install Spool as a newcomer would, on a machine that has never seen it, and use it once.
#
# Everything happens under one temp folder: an empty HOME (no ~/.claude, no ~/.config/spool), its
# own npm prefix and cache, its own TMPDIR. Nothing outside it is read or written, so it is safe
# to run on your own machine:
#
#   bash scripts/fresh-install.sh
#
# Steps: npm pack this checkout, npm install -g the tarball (what npm and GitHub installs both
# do), spool --version, spool install, spool demo, spool init in a new git repository,
# spool doctor, spool page -d on a free port, fetch the board, spool page --stop.
# KEEP=1 keeps the temp folder to look at afterwards.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/spool-fresh-XXXXXX")" && pwd -P)"
mkdir -p "$scratch/user" "$scratch/prefix" "$scratch/cache" "$scratch/tmp" "$scratch/pack"

project=""
cleanup() {
  status=$?
  if [ -n "$project" ] && [ -d "$project/.spool" ]; then
    (cd "$project" && spool page --stop >/dev/null 2>&1) || true
  fi
  if [ "${KEEP:-}" = 1 ] || [ "$status" -ne 0 ]; then
    echo "fresh-install: kept $scratch"
  else
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT

# A clean machine: nothing of the real user's reaches the steps below.
export HOME="$scratch/user"
export TMPDIR="$scratch/tmp"
export npm_config_prefix="$scratch/prefix"
export npm_config_cache="$scratch/cache"
export npm_config_userconfig="$scratch/user/.npmrc"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false
unset XDG_CONFIG_HOME CLAUDE_CONFIG_DIR CODEX_HOME BROWSER SPOOL_AS SPOOL_AGENT SPOOL_NOTIFY || true
# Only the tools the steps need are on the PATH, so no other agent on this machine is seen. Claude
# Code is linked in where it is installed (README step 1); a machine without it, like CI, is told so.
mkdir -p "$scratch/bin"
for tool in node npm git curl claude; do
  found="$(command -v "$tool" || true)"
  if [ -n "$found" ]; then ln -s "$found" "$scratch/bin/$tool"
  elif [ "$tool" != claude ]; then echo "fresh-install: needs $tool" >&2; exit 1; fi
done
export PATH="$scratch/prefix/bin:$scratch/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GIT_CONFIG_GLOBAL="$scratch/user/.gitconfig"
git config --global user.name "Fresh Install"
git config --global user.email "fresh@example.invalid"
git config --global init.defaultBranch main

step() { printf '\n== %s\n' "$*"; }
fail() { echo "fresh-install: FAILED: $*" >&2; exit 1; }

step "npm pack"
tarball="$(cd "$repo" && npm pack --silent --pack-destination "$scratch/pack" | tail -n 1)"
[ -f "$scratch/pack/$tarball" ] || fail "npm pack made no tarball"
echo "$tarball"

step "npm install -g $tarball"
npm install -g "$scratch/pack/$tarball"
[ "$(command -v spool)" = "$scratch/prefix/bin/spool" ] || fail "spool is not the one just installed: $(command -v spool)"

step "spool --version"
version="$(spool --version)"
echo "$version"
expected="$(node -p "require('$repo/package.json').version")"
case "$version" in *"$expected"*) ;; *) fail "spool --version says '$version', package.json says $expected" ;; esac

step "spool install"
spool install
[ -f "$HOME/.claude/skills/spool/SKILL.md" ] || fail "spool install put no skill in $HOME/.claude/skills"

step "spool demo"
spool demo "$scratch/demo"
[ -d "$scratch/demo/.spool" ] || fail "spool demo made no spool"
(cd "$scratch/demo" && spool status)

step "spool init in a new git repository"
project="$scratch/project"
mkdir -p "$project"
cd "$project"
git init -q
echo "# A project" > README.md
git add README.md
git commit -q -m "First commit"
spool init
[ -d "$project/.spool" ] || fail "spool init made no .spool"

step "spool doctor"
# Something wrong fails the run. Advice does not: it is what a new project is told to do next.
# The one thing allowed wrong is Claude Code missing from a machine that has none.
doctor_status=0
doctor="$(spool doctor)" || doctor_status=$?
echo "$doctor"
wrong="$(printf '%s\n' "$doctor" | grep '^✗' || true)"
if [ ! -e "$scratch/bin/claude" ]; then
  wrong="$(printf '%s\n' "$wrong" | grep -v '^✗ the agent command starts claude, which is not on the PATH' || true)"
elif [ "$doctor_status" -ne 0 ]; then
  fail "spool doctor exited $doctor_status"
fi
[ -z "$wrong" ] || fail "spool doctor found something wrong: $wrong"

step "spool page -d"
port="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
spool page -d --no-open --port "$port"
url="http://127.0.0.1:$port/"
body=""
for _ in $(seq 1 50); do
  if body="$(curl -fsS "$url" 2>/dev/null)"; then break; fi
  body=""
  sleep 0.2
done
[ -n "$body" ] || fail "the board at $url did not answer"
code="$(curl -s -o /dev/null -w '%{http_code}' "$url")"
[ "$code" = 200 ] || fail "the board at $url answered $code"
title="$(printf '%s' "$body" | sed -n 's:.*<title>\(.*\)</title>.*:\1:p' | head -n 1)"
[ -n "$title" ] || fail "the board at $url has no <title>"
echo "$url answered $code: $title"
spool page --status

step "spool page --stop"
spool page --stop
if curl -fsS "$url" >/dev/null 2>&1; then fail "the board at $url still answers after --stop"; fi
project=""

printf '\nfresh-install: passed (%s)\n' "$version"
