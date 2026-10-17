#!/usr/bin/env bash
# steward-prep-delivery duplicate-detection helper (#1269).
#
# Given search terms (the proposed issue title or keywords), surface likely
# duplicates from two sources:
#   1. The local AIWG capability index via `aiwg discover` (in case the user
#      is about to file an issue against a feature that already exists or is
#      already tracked as a skill/agent/rule).
#   2. The Gitea issue tracker for the project's configured `remotes.issue_tracker`
#      (if credentials are available — falls back gracefully if not).
#
# Output: human-readable ranked list. The caller decides whether to file new
# or comment on an existing issue.

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: aiwg run skill steward-prep-delivery -- <search terms>"
  echo ""
  echo "Example:"
  echo "  aiwg run skill steward-prep-delivery -- steward capability matrix"
  echo ""
  echo "Searches local AIWG index (via aiwg discover) and Gitea issue tracker"
  echo "for likely duplicates before you file a new issue."
  exit 2
fi

QUERY="$*"

echo "Searching for duplicates of: ${QUERY}"
echo "================================================================"
echo ""

# 1. Local AIWG capability index — surfaces existing skills/agents/rules/commands
#    that match the proposed work. If a skill already does the thing, the user
#    may not need to file at all.
echo "## Local AIWG index (aiwg discover)"
echo ""
if command -v aiwg >/dev/null 2>&1; then
  DISCOVER_TMP_DIR=""
  DISCOVER_JSON=""
  DISCOVER_PID=""
  DISCOVER_CANDIDATE=""
  cleanup_discover_tmp() {
    if [ -n "${DISCOVER_TMP_DIR:-}" ] && [ -d "${DISCOVER_TMP_DIR}" ]; then
      rm -rf -- "${DISCOVER_TMP_DIR}"
    fi
    # Signaled while still waiting on mkdir: the candidate may already exist.
    # It is empty at that point, so rmdir removes ours and never removes a
    # non-empty directory someone else owns.
    if [ -n "${DISCOVER_CANDIDATE:-}" ]; then
      rmdir -- "${DISCOVER_CANDIDATE}" 2>/dev/null || true
    fi
  }
  terminate_discover() {
    if [ -n "${DISCOVER_PID:-}" ] && kill -0 "${DISCOVER_PID}" 2>/dev/null; then
      kill "${DISCOVER_PID}" 2>/dev/null || true
      wait "${DISCOVER_PID}" 2>/dev/null || true
    fi
    DISCOVER_PID=""
  }
  handle_discover_signal() {
    local exit_code="$1"
    trap - HUP INT TERM
    terminate_discover
    cleanup_discover_tmp
    exit "${exit_code}"
  }
  trap cleanup_discover_tmp EXIT
  trap 'handle_discover_signal 129' HUP
  trap 'handle_discover_signal 130' INT
  trap 'handle_discover_signal 143' TERM

  # Create the temp dir as a background job reaped by the interruptible `wait`
  # builtin. A foreground mktemp command substitution makes bash defer HUP/INT/TERM
  # traps until mktemp exits, and under CI load that stalled signal handling
  # for seconds after the directory already existed (#2982). The name is
  # generated in bash and created atomically by `mkdir -m 700`, which fails if
  # the path exists and never follows a symlink, so no predictable helper file
  # in the shared temp dir is needed. Works with bash 3.2. @implements #2107
  DISCOVER_ATTEMPT=0
  while [ -z "${DISCOVER_TMP_DIR}" ] && [ "${DISCOVER_ATTEMPT}" -lt 5 ]; do
    DISCOVER_ATTEMPT=$((DISCOVER_ATTEMPT + 1))
    DISCOVER_CANDIDATE="${TMPDIR:-/tmp}/steward-prep-discover.$$.${RANDOM}${RANDOM}"
    mkdir -m 700 -- "${DISCOVER_CANDIDATE}" 2>/dev/null &
    DISCOVER_PID=$!
    if wait "${DISCOVER_PID}"; then
      DISCOVER_TMP_DIR="${DISCOVER_CANDIDATE}"
    fi
    DISCOVER_PID=""
    DISCOVER_CANDIDATE=""
  done
  if [ -n "${DISCOVER_TMP_DIR}" ]; then
    DISCOVER_JSON="${DISCOVER_TMP_DIR}/discover.json"

    # Keep ownership of the discovery child so signal cleanup does not depend on
    # the caller creating and signalling a separate process group. @implements #2107
    aiwg discover "${QUERY}" --limit 5 --json >"${DISCOVER_JSON}" 2>/dev/null &
    DISCOVER_PID=$!
    if wait "${DISCOVER_PID}"; then
      DISCOVER_PID=""
      python3 - "${DISCOVER_JSON}" <<'PY' 2>/dev/null || echo "  (python3 not available to parse output)"
import json
import sys

try:
    with open(sys.argv[1], encoding='utf-8') as handle:
        data = json.load(handle)
    results = data.get('results', [])
    if not results:
        print('  (no matching artifacts)')
    else:
        for r in results[:5]:
            score = r.get('score', 0)
            kind = r.get('type', '?')
            name = r.get('name', '?')
            capability = r.get('capability', '')[:80]
            print(f'  - {kind:8s}  score={score:.2f}  {name}')
            if capability:
                print(f'              {capability}')
except Exception as e:
    print(f'  (parse error: {e})')
PY
    else
      DISCOVER_PID=""
      echo "  (aiwg discover failed — local index may not be built)"
    fi
  else
    echo "  (failed to create discovery temp dir)"
  fi
else
  echo "  (aiwg CLI not found in PATH)"
fi
echo ""

# 2. Gitea issue tracker search. Reads issues:provider from .aiwg/aiwg.config or
#    falls back to roctinam/aiwg on git.integrolabs.net.
echo "## Gitea issues (open)"
echo ""

GITEA_URL="${GITEA_URL:-https://git.integrolabs.net}"
GITEA_OWNER="${GITEA_OWNER:-}"
GITEA_REPO="${GITEA_REPO:-}"

# Try to read from aiwg.config first
if [ -z "$GITEA_OWNER" ] || [ -z "$GITEA_REPO" ]; then
  if [ -f "${AIWG_PROJECT_ROOT:-$PWD}/.aiwg/aiwg.config" ] && command -v python3 >/dev/null 2>&1; then
    eval "$(python3 -c "
import json, sys
try:
    c = json.load(open('${AIWG_PROJECT_ROOT:-$PWD}/.aiwg/aiwg.config'))
    issues = c.get('issues', {})
    print(f'GITEA_OWNER_CFG={issues.get(\"owner\",\"\")!r}')
    print(f'GITEA_REPO_CFG={issues.get(\"repo\",\"\")!r}')
except Exception:
    pass
" 2>/dev/null)"
    GITEA_OWNER="${GITEA_OWNER:-${GITEA_OWNER_CFG:-}}"
    GITEA_REPO="${GITEA_REPO:-${GITEA_REPO_CFG:-}}"
  fi
fi

# Fall back to parsing git remote
if [ -z "$GITEA_OWNER" ] || [ -z "$GITEA_REPO" ]; then
  REMOTE_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
  if [[ "$REMOTE_URL" =~ git\.integrolabs\.net[:/]+([^/]+)/([^/.]+) ]]; then
    GITEA_OWNER="${BASH_REMATCH[1]}"
    GITEA_REPO="${BASH_REMATCH[2]}"
  fi
fi

if [ -z "$GITEA_OWNER" ] || [ -z "$GITEA_REPO" ]; then
  echo "  (could not determine Gitea owner/repo — set GITEA_OWNER and GITEA_REPO or configure issues.{owner,repo} in .aiwg/aiwg.config)"
  echo ""
  echo "================================================================"
  echo "Review the candidates above. If any match your proposed issue,"
  echo "prefer commenting on the existing thread over filing a new issue."
  exit 0
fi

# Token loading from standard location. Avoid logging the token value.
GITEA_TOKEN_FILE="${GITEA_TOKEN_FILE:-$HOME/.config/gitea/token}"
if [ ! -f "$GITEA_TOKEN_FILE" ] && [ -z "${GITEA_TOKEN:-}" ]; then
  echo "  (Gitea token not found at $GITEA_TOKEN_FILE — skipping live issue search)"
  echo "  To enable, place a Gitea API token at $GITEA_TOKEN_FILE (chmod 600)."
  echo ""
  echo "================================================================"
  echo "Review the candidates above. If any match your proposed issue,"
  echo "prefer commenting on the existing thread over filing a new issue."
  exit 0
fi

# Scoped token load via heredoc — token never persists in caller's environment.
bash <<EOF
TOKEN=\$(cat "$GITEA_TOKEN_FILE" 2>/dev/null || echo "\${GITEA_TOKEN:-}")
if [ -z "\$TOKEN" ]; then
  echo "  (token file empty)"
  exit 0
fi
# URL-encode the query (basic — just replace spaces and a few specials).
ENCODED_QUERY=\$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "${QUERY}")
API_URL="${GITEA_URL}/api/v1/repos/issues/search?state=open&type=issues&owner=${GITEA_OWNER}&q=\${ENCODED_QUERY}&limit=10"
RESP=\$(curl -sS -H "Authorization: token \$TOKEN" "\$API_URL" 2>/dev/null || echo "[]")
python3 -c "
import json, sys
try:
    issues = json.loads(sys.argv[1])
    if not isinstance(issues, list) or not issues:
        print('  (no open issues match the search terms)')
    else:
        for i in issues[:10]:
            num = i.get('number', '?')
            title = i.get('title', '?')[:100]
            updated = (i.get('updated_at') or '')[:10]
            print(f'  #{num:5}  {updated}  {title}')
except Exception as e:
    print(f'  (parse error: {e})')
" "\$RESP"
EOF

echo ""
echo "================================================================"
echo "Review the candidates above. If any match your proposed issue,"
echo "prefer commenting on the existing thread over filing a new issue."
echo "If none match, proceed with filing using the appropriate template:"
echo "  - .gitea/ISSUE_TEMPLATE/bug-report.md"
echo "  - .gitea/ISSUE_TEMPLATE/feature-request.md"
echo "  - .gitea/ISSUE_TEMPLATE/tester-report.md"
echo "  - .gitea/ISSUE_TEMPLATE/imported-report.md"
