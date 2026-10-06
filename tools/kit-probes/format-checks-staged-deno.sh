#!/usr/bin/env bash
# guards: templates/deno/gate.sh
#
# Kit-conformance probe for the kit fix of 2026-10-06: `format-checks-staged-deno`.
#
# WHY A PROBE
#   A kit fix that ships as prose is a fix nobody can check. This file drives a copy of the gate under
#   test through the state the fix exists for and reports whether the gate catches it.
#
# THE CONTRACT
#   `deno fmt` checks files as they are ON DISK; a commit records the INDEX. A gate that reads only the
#   disk passes while a commit lands unformatted text, and the failure surfaces later as an unhelpful
#   "uncommitted changes" on the next push. The format stage must check the staged copy too.
#
# WHAT IT CHECKS
#   P0  the fixtures are what they claim: that a formatted fixture is formatted and an unformatted one
#       is not, tested with the fix's own primitive. A fixture that is accidentally formatted makes
#       everything below vacuous. Measured lesson: `deno fmt --check --ext ts -` returns 0 even for
#       UNFORMATTED stdin, so --check cannot be the primitive; format-and-compare can.
#   P1  CONTRACT: index unformatted, working tree formatted, both differing from HEAD so the file is in
#       the gate's touched set -> the gate must report a deno fmt failure.
#   P2  NEGATIVE CONTROL: index == working tree, formatted -> no deno fmt failure, so the fix cannot
#       mean "fail whenever the tree is dirty".
#   P3  PARTIAL STAGE: index formatted, working tree formatted but different -> no deno fmt failure,
#       so the fix cannot outlaw `git add -p`.
#
#   The scratch repo contains the gate, a deno.json and one source file -- no app, no tasks, no DB. A
#   `deno` shim on PATH turns `deno task`/`deno check`/`deno lint` into no-ops so ONLY the format stage
#   can fail, and the verdict is read from the gate's own output rather than its exit status, because
#   the real app's other stages cannot pass in a scratch repo. Any gate that prints a deno fmt failure
#   for the P1 state passes this probe; how it words it does not matter.
#
# Run: probes/format-checks-staged-deno.sh <gate-script> [repo-root]
set -uo pipefail
G=${1:?usage: format-checks-staged-deno.sh <gate-script> [repo-root]}
[ -f "$G" ] || { printf 'PROBE FAILED (no such file: %s)\n' "$G"; exit 1; }
ROOT=${2:-$(cd "$(dirname "$G")/.." && pwd)}
fails=0; oks=0
check() { if [ "$1" = "0" ]; then oks=$((oks+1)); printf '  ok   %s\n' "$2"; else fails=$((fails+1)); printf '  FAIL %s\n' "$2"; fi; }
# deno is not on a non-login PATH; the gates export it themselves, and so does this probe
export PATH="$HOME/.deno/bin:$PATH"
command -v deno >/dev/null 2>&1 || { printf 'PROBE SKIPPED (no deno on PATH)\n'; exit 0; }
grep -q 'deno fmt' "$G" || { printf 'PROBE SKIPPED (this gate has no deno fmt stage)\n'; exit 0; }
REAL_DENO=$(command -v deno)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"; mkdir -p "$REPO/scripts" "$REPO/src" "$TMP/bin"
cp "$G" "$REPO/scripts/gate.sh"
# the project's own deno.json, so its fmt options apply; only the tasks become no-ops
if [ -f "$ROOT/deno.json" ]; then
  python3 - "$ROOT/deno.json" "$REPO/deno.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg["tasks"] = {k: "true" for k in cfg.get("tasks", {})}
json.dump(cfg, open(sys.argv[2], "w"), indent=2)
PY
else
  printf '{"tasks": {}}\n' > "$REPO/deno.json"
fi
# The scratch config is untracked, so it is in the gate's touched set and deno WILL check it; written by
# python it is not in deno's own style (no newline, no inner spaces), which produces a deno fmt failure
# that has nothing to do with the contract -- the first version of this probe failed its P2 that way.
"$REAL_DENO" fmt "$REPO/deno.json" >/dev/null 2>&1
cat > "$TMP/bin/deno" <<SH
#!/usr/bin/env bash
case "\${1:-}" in task|check|lint) exit 0 ;; *) exec "$REAL_DENO" "\$@" ;; esac
SH
chmod +x "$TMP/bin/deno"

# the primitive this fix rests on: format the text, compare it to itself
is_formatted() { "$REAL_DENO" fmt --ext "$2" - < "$1" | diff -q - "$1" >/dev/null 2>&1; }
cd "$REPO" || exit 1
git init -q -b main . && git config user.email probe@kit && git config user.name probe
# Fixtures are built INSIDE the repo (so the gate's own deno.json applies) and copied with cp, never
# through $(cat ...): command substitution strips the trailing newline, which makes a file deno fmt just
# wrote count as unformatted -- the first version of this probe failed its own P0 for that reason.
printf 'export const probeValue = 1;\n' > src/fixture.ts
"$REAL_DENO" fmt src/fixture.ts >/dev/null 2>&1
printf '// a second formatted variant\n' >> src/fixture.ts
"$REAL_DENO" fmt src/fixture.ts >/dev/null 2>&1
cp src/fixture.ts "$TMP/good2.ts"
printf 'export const probeValue = 1;\n' > src/fixture.ts
cp src/fixture.ts "$TMP/good.ts"
printf 'export   const   probeValue=1;\n' > "$TMP/bad.ts"
is_formatted "$TMP/bad.ts" ts;  check $([ $? -ne 0 ] && echo 0 || echo 1) "P0 the 'unformatted' fixture is text deno fmt rewrites"
is_formatted "$TMP/good.ts" ts; check $? "P0 the 'formatted' fixture is text deno fmt leaves alone"
is_formatted "$TMP/good2.ts" ts; check $? "P0 the second 'formatted' fixture is text deno fmt leaves alone (P3 rests on it)"

cp "$TMP/good.ts" src/fixture.ts
git add -A >/dev/null && git commit -qm base
# run the gate for a given (index text, working-tree text); report whether it flags deno fmt
run_gate() {
  cp "$1" src/fixture.ts && git add src/fixture.ts
  cp "$2" src/fixture.ts
  # NB: read the output into a variable first. With `set -o pipefail` (set at the top) the pipeline's
  # status is the GATE's -- non-zero here by design, since the real app's other stages cannot pass in a
  # scratch repo -- so `gate | grep -q ... && echo yes` answers "no" no matter what the gate said.
  out="$(PATH="$TMP/bin:$PATH" bash scripts/gate.sh 2>&1 || true)"
  printf '%s\n' "$out" | grep -q 'deno fmt' && echo yes || echo no
}
check $([ "$(run_gate "$TMP/bad.ts" "$TMP/good.ts")" = yes ] && echo 0 || echo 1) \
  "P1 CONTRACT: unformatted in the index, formatted on disk -> the gate flags the staged copy"
check $([ "$(run_gate "$TMP/good.ts" "$TMP/good.ts")" = no ] && echo 0 || echo 1) \
  "P2 NEGATIVE CONTROL: index == working tree, formatted -> no deno fmt failure"
check $([ "$(run_gate "$TMP/good.ts" "$TMP/good2.ts")" = no ] && echo 0 || echo 1) \
  "P3 PARTIAL STAGE: index formatted, working tree different but formatted -> no deno fmt failure"

printf 'PROBE %s (%s ok, %s failed)\n' "$([ "$fails" -eq 0 ] && echo VERIFIED || echo FAILED)" "$oks" "$fails"
[ "$fails" -eq 0 ]
