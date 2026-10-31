#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]{4}\.([1-9]|1[0-2])\.(0|[1-9][0-9]*)$ ]]; then
  echo "Usage: $0 YYYY.M.PATCH" >&2
  exit 2
fi

for PACKAGE in aiwg @aiwg/cli @aiwg/cockpit @aiwg/flue; do
  VERIFIED=false
  for ATTEMPT in 1 2 3 4 5; do
    TAGS=$(npm dist-tag ls "$PACKAGE" --registry=https://registry.npmjs.org)
    if grep -Fxq "latest: ${VERSION}" <<< "$TAGS" &&
       ! grep -Eq '^next: ' <<< "$TAGS"; then
      echo "✓ ${PACKAGE}@latest = ${VERSION}; @next absent"
      VERIFIED=true
      break
    fi
    if [ "$ATTEMPT" -lt 5 ]; then sleep 5; fi
  done
  if [ "$VERIFIED" != true ]; then
    echo "✗ ${PACKAGE} requires latest = ${VERSION} and no next dist-tag" >&2
    echo "$TAGS" >&2
    exit 1
  fi
done
