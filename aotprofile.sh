#!/bin/bash
# Generate the profile-only AOT profile for an IKVM assembly, regenerating when
# (and only when) its inputs change.
#
# WHY THE STAMP: this script used to `exit` early whenever $OUT already existed.
# That silently pinned a STALE profile — after the Makefile's filter list changed
# (e.g. `sun.security.` was added) or IKVM.Java.dll was rebuilt, the profile was
# never regenerated. Since AOT here is `profile-only` (only listed methods get
# compiled, everything else falls to the interpreter), the stale profile quietly
# dropped whole namespaces (the entire sun.security.* crypto stack) to interp.
# We now key a stamp on the input DLL's identity + the exact filter args + the
# contents of any @<file> lists + the generator source, and regenerate on change.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

OUT="$(realpath "$1")"
shift
IN="$(realpath "$1")"
shift

# Resolve "@<path>" filter args to absolute paths while still in the repo root,
# since the program runs from aotprofile/ where the relative path would break.
ARGS=()
for arg in "$@"; do
	if [[ "$arg" == @* ]]; then
		ARGS+=("@$(realpath "${arg:1}")")
	else
		ARGS+=("$arg")
	fi
done

STAMP="$OUT.stamp"

# Signature of everything that determines the profile's contents. Any change
# busts the stamp and forces regeneration.
compute_sig() {
	# input DLL identity (mtime + size) — a rebuilt IKVM.Java.dll re-triggers
	stat -c '%Y %s' "$IN" 2>/dev/null || true
	# the exact filter args
	printf 'ARG:%s\n' "${ARGS[@]}"
	# contents of any @<file> curated lists (e.g. fastutil-aot-classes.txt)
	local a
	for a in "${ARGS[@]}"; do
		if [[ "$a" == @* ]]; then
			printf 'FILE:%s\n' "${a:1}"
			cat "${a:1}" 2>/dev/null || true
		fi
	done
	# the generator itself
	cat "$SCRIPT_DIR/aotprofile/Program.cs" 2>/dev/null || true
}

NEWSIG="$(compute_sig | sha256sum | cut -d' ' -f1)"

if [ -f "$OUT" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$NEWSIG" ]; then
	echo "[aotprofile] '$OUT' up to date (inputs unchanged), skipping"
	exit 0
fi

echo "[aotprofile] (re)generating '$OUT' ..."
rm -f "$OUT"
( cd "$SCRIPT_DIR/aotprofile" && dotnet run -- "$OUT" "$IN" "${ARGS[@]}" >/dev/null )
echo "$NEWSIG" > "$STAMP"
echo "[aotprofile] wrote '$OUT'"
