#!/usr/bin/env bash
# usage: mkpkg.sh <pkgname> <file>...  — snapshot files into a review package
set -euo pipefail
out=".superpowers/sdd/2026-08-16-remote-pi-web/$1"
{
  echo "# Review package: $1"
  echo "Changed files: ${*:2}"
  for f in "${@:2}"; do
    echo
    echo "===== FILE: $f ====="
    cat "$f"
    echo "===== END: $f ====="
  done
} > "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
