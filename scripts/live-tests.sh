#!/bin/zsh
# Daily LIVE test run of mcp-web-search on the workhorse (launchd net.leanzero.mcp-web-search-livetests, 05:20).
#
# WHY here and not in GitHub Actions: the integration suites call the live web, GitHub and (with a key) Serper;
# the repo is PUBLIC, so a self-hosted runner would let fork PRs run code on the workhorse. This script runs only
# origin/main, in its own clone, never the live service's working copy (com.user.mcp-web-search runs that copy's
# dist/ on :8443; the tests start their own stdio servers and bind HTTP test servers to port 0).
#
# What it does:
#   1. fetch origin/main (anonymous https, global git config bypassed) into ~/.local/share/mcp-web-search-livetests/repo
#   2. npm ci with a PRIVATE npm cache (~/.npm holds root-owned files on the workhorse; npm ci there fails EACCES)
#   3. npm run build, then `vitest run` (unit + integration), one test file at a time
#   4. writes $STATE_DIR/websearch-livetests.json (read by leanzero-analytics service_health.py check
#      websearch_livetests) and a log next to it; exits non-zero when anything failed
#
# Keys (never printed, never written to the result):
#   SERPER_API_KEY / UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN: from ~/.config/mcp-web-search-livetests/env
#     (KEY=value lines, mode 600). Without SERPER_API_KEY every search test SKIPS (the server is Serper-only by
#     design); the result JSON records how many were skipped and why. A full run costs ~31 Serper credits, so this
#     must be a dedicated key, not the website's (WEB_SEARCH_SERPER_KEY, ~150 credits shared with the advisors).
#   GITHUB_TOKEN: from that file, else `gh auth token`. Anonymous GitHub calls would spend the workhorse IP's
#     60 req/h quota that the live server's keyless users share.
# Env overrides (for a manual run): LIVETESTS_WORK, LIVETESTS_STATE_DIR, LIVETESTS_REF (default origin/main),
#   LIVETESTS_REPO_URL (e.g. a local clone, to try unpushed commits).
set -u
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
WORK="${LIVETESTS_WORK:-$HOME/.local/share/mcp-web-search-livetests}"
STATE_DIR="${LIVETESTS_STATE_DIR:-$HOME/.claude/skills/leanzero-analytics/state/service_health}"
REF="${LIVETESTS_REF:-origin/main}"
REPO_URL="${LIVETESTS_REPO_URL:-https://github.com/leanzero-srl/mcp-web-search.git}"
KEYS_FILE="$HOME/.config/mcp-web-search-livetests/env"
RESULT="$STATE_DIR/websearch-livetests.json"
LOG="$STATE_DIR/websearch-livetests.log"
VITEST_JSON="$WORK/vitest-result.json"
mkdir -p "$WORK" "$STATE_DIR"

# One run at a time (a 05:20 run and a manual kickstart must not share the clone).
LOCK="$WORK/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +90 2>/dev/null)" ]; then rmdir "$LOCK"; mkdir "$LOCK"; else
    echo "live-tests: another run holds $LOCK; exiting" >&2; exit 75; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

START=$(date +%s)
STAGE=setup
exec > >(tee "$LOG") 2>&1
echo "== mcp-web-search live tests $(date '+%Y-%m-%d %H:%M:%S %Z') ref=$REF"

write_result() {  # $1 = exit code, $2 = stage reached
  EXIT_CODE="$1" STAGE="$2" START="$START" COMMIT="${COMMIT:-}" VITEST_JSON="$VITEST_JSON" RESULT="$RESULT" LOG="$LOG" \
  HAS_SERPER="${SERPER_API_KEY:+1}" HAS_GITHUB="${GITHUB_TOKEN:+1}" /usr/bin/python3 - <<'PY'
import json, os, time
e = os.environ
out = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "exit_code": int(e["EXIT_CODE"]), "stage": e["STAGE"],
       "commit": e["COMMIT"], "duration_s": int(time.time()) - int(e["START"]), "log": e["LOG"],
       "serper_key": bool(e.get("HAS_SERPER")), "github_token": bool(e.get("HAS_GITHUB"))}
try:
    d = json.load(open(e["VITEST_JSON"])) if e["STAGE"] == "tests" else None
except (OSError, ValueError):
    d = None
if d:
    out.update(total=d["numTotalTests"], passed=d["numPassedTests"], failed=d["numFailedTests"],
               skipped=d["numPendingTests"] + d.get("numTodoTests", 0))
    fails, skips = [], []
    for f in d["testResults"]:
        name = os.path.relpath(f["name"], os.path.join(os.path.dirname(e["VITEST_JSON"]), "repo"))
        if f.get("status") == "failed" and not f["assertionResults"]:
            fails.append({"file": name, "test": "(file failed to load)", "message": (f.get("message") or "")[:300]})
        for a in f["assertionResults"]:
            if a["status"] == "failed":
                fails.append({"file": name, "test": a["title"], "message": (a.get("failureMessages") or [""])[0][:300]})
            elif a["status"] in ("skipped", "pending", "todo"):
                skips.append(a["title"])
    out["failures"] = fails[:30]
    out["skipped_search"] = sum(1 for t in skips if "no SERPER_API_KEY" in t)
    out["skipped_other"] = len(skips) - out["skipped_search"]
    out["ok"] = out["exit_code"] == 0 and out["failed"] == 0 and out["passed"] > 0
else:
    out["ok"] = False
    out["failures"] = [{"file": "-", "test": f"stage '{e['STAGE']}' failed", "message": "see log"}]
tmp = e["RESULT"] + ".tmp"
json.dump(out, open(tmp, "w"), indent=1)
os.replace(tmp, e["RESULT"])
print(f"== result: {'OK' if out['ok'] else 'FAILED'} -> {e['RESULT']}")
PY
}

fail() { echo "live-tests: FAILED at stage $STAGE"; write_result "${1:-1}" "$STAGE"; exit "${1:-1}"; }

# 1. dedicated clone, anonymous https (GIT_CONFIG_GLOBAL bypasses the user's https->ssh insteadOf rewrite,
#    which would need an ssh key launchd does not have).
STAGE=fetch
export GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
if [ ! -d "$WORK/repo/.git" ]; then
  git clone --quiet "$REPO_URL" "$WORK/repo" || fail 2
fi
cd "$WORK/repo" || fail 2
git fetch --quiet origin main || fail 2
# This clone is ours alone and never edited: force the tree to exactly the tested ref.
git checkout --quiet --force --detach "$REF" || fail 2
git clean -fdxq -e node_modules || fail 2
COMMIT=$(git rev-parse --short HEAD)
echo "== commit $COMMIT $(git log -1 --format='%s' | cut -c1-100)"

# 2-3. install + build with a private cache
STAGE=install
export npm_config_cache="$WORK/npm-cache" npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
nice -n 10 npm ci --no-audit --no-fund || fail 3
STAGE=build
nice -n 10 npm run build || fail 3

# Keys: read ONLY the names we need (never `source` a file into the test env).
STAGE=keys
read_key() { [ -r "$KEYS_FILE" ] && sed -n "s/^$1=//p" "$KEYS_FILE" | tail -1 | tr -d '\r' | sed "s/^[\"']//; s/[\"']\$//"; }
for k in SERPER_API_KEY UPSTASH_VECTOR_REST_URL UPSTASH_VECTOR_REST_TOKEN GITHUB_TOKEN; do
  v=$(read_key "$k"); [ -n "$v" ] && export "$k=$v"
done
if [ -z "${GITHUB_TOKEN:-}" ]; then v=$(gh auth token 2>/dev/null); [ -n "$v" ] && export GITHUB_TOKEN="$v"; fi
unset v
# Never inherit the live server's settings (DATA_DIR, PORT, PUBLIC_HOST, admin/provision secrets).
unset DATA_DIR PORT PUBLIC_HOST OUTPUT_DIR DOC_OUTPUT_DIR CRAWL_CACHE_DIR MCP_WEB_SEARCH_ADMIN_TOKEN PROVISION_SECRET FILE_TOKEN_SECRET USE_SERPER_ONLY ENABLE_BROWSER_FALLBACKS
yn() { [ -n "${(P)1:-}" ] && echo yes || echo no; }   # presence only, never the value
echo "== keys: serper=$(yn SERPER_API_KEY) github=$(yn GITHUB_TOKEN) upstash=$(yn UPSTASH_VECTOR_REST_URL)"

# 4. tests: unit + integration, one file at a time (polite to the sites the suites call)
STAGE=tests
rm -f "$VITEST_JSON"
export RUN_STREAMING_TEST=1 MCP_TEST_LOG_DIR="$WORK/server-logs"
rm -rf "$MCP_TEST_LOG_DIR"
nice -n 10 npx vitest run --no-file-parallelism --reporter=default --reporter=json --outputFile="$VITEST_JSON"
RC=$?
write_result "$RC" tests
/usr/bin/python3 -c "import json,sys; sys.exit(0 if json.load(open('$RESULT'))['ok'] else 1)"
exit $?
