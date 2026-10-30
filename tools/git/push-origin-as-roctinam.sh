#!/usr/bin/env bash
# Push AIWG through its project-dedicated Gitea SSH key as roctinam.

set -euo pipefail
set +x
umask 077

ROOT="$(git rev-parse --show-toplevel)"
ROLE="${AIWG_GIT_VAULT_ROLE:-$(git config --local --get aiwg.vault.readerRole)}"
KEY_PATH="${AIWG_GIT_SSH_KEY_VAULT_PATH:-$(git config --local --get aiwg.vault.sshKeyPath)}"
TOKEN_HELPER="${OPENBAO_TOKEN_HELPER:-/home/roctinam/dev/itops/scripts/lib/openbao-token.sh}"
source "${OPENBAO_ENV:-/home/roctinam/.config/openbao/env}"

[[ -n "$ROLE" && -n "$KEY_PATH" ]] || { echo 'FAIL: AIWG Git vault routing is not configured.' >&2; exit 1; }
for candidate in "${XDG_RUNTIME_DIR:-}" /dev/shm; do
  if [[ -n "$candidate" && -d "$candidate" && -w "$candidate" && "$(stat -f -c %T "$candidate" 2>/dev/null || true)" == tmpfs ]]; then
    RUNTIME_PARENT="$candidate"
    break
  fi
done
[[ -n "${RUNTIME_PARENT:-}" ]] || { echo 'FAIL: writable tmpfs is required.' >&2; exit 1; }

TMP="$(mktemp -d "$RUNTIME_PARENT/aiwg-git-push.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM
TOKEN="$($TOKEN_HELPER approle "$ROLE")"
curl -fsS --config /dev/fd/3 "$BAO_ADDR/v1/$KEY_PATH" \
  3<<<"header = \"X-Vault-Token: $TOKEN\"" > "$TMP/secret.json"
jq -er '.data.data.private_key' "$TMP/secret.json" > "$TMP/id_ed25519"
chmod 600 "$TMP/id_ed25519"

SSH_COMMAND="ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=$TMP/id_ed25519"
identity="$($SSH_COMMAND -T git@git.integrolabs.net 2>&1 || true)"
grep -q 'roctinam' <<<"$identity" || { echo 'FAIL: AIWG key did not authenticate as roctinam.' >&2; exit 1; }
if [[ "${1:-}" == --check ]]; then
  echo 'Gitea SSH authentication passed for roctinam.'
  exit 0
fi
# Commit policy (WORKSPACE.md "Commit identity and attribution"): every commit
# this push adds to origin must use the approved identity, carry its signature,
# and have no attribution lines. Commits already on origin are not rechecked.
APPROVED_EMAIL='1159087+jmagly@users.noreply.github.com'
APPROVED_KEY='25BEE160811F66FD6F7B1BF0454C68C4A2174CE9'
violations=0
for arg in "$@"; do
  [[ "$arg" == -* || "$arg" == :* ]] && continue
  src="${arg%%:*}"; src="${src#+}"
  git -C "$ROOT" rev-parse -q --verify "$src^{commit}" >/dev/null || continue
  while read -r sha; do
    meta="$(git -C "$ROOT" log -1 --format='%G?|%GF|%GP|%ae|%ce' "$sha")"
    IFS='|' read -r sig fpr primary author committer <<<"$meta"
    problem=''
    [[ "$author" == "$APPROVED_EMAIL" && "$committer" == "$APPROVED_EMAIL" ]] || problem="identity $author / $committer"
    [[ "$sig" == G || "$sig" == U ]] && [[ "$fpr" == "$APPROVED_KEY" || "$primary" == "$APPROVED_KEY" ]] || problem="${problem:+$problem; }signature $sig ${fpr:-none}"
    git -C "$ROOT" log -1 --format=%B "$sha" | grep -qiE '^co-authored-by:|generated with \[?claude|generated with \[?codex' && problem="${problem:+$problem; }attribution line"
    if [[ -n "$problem" ]]; then echo "FAIL: ${sha:0:9} $problem" >&2; violations=$((violations + 1)); fi
  done < <(git -C "$ROOT" rev-list "$src" --not --remotes=origin)
done
(( violations == 0 )) || { echo "FAIL: $violations commit(s) break the commit policy; nothing was pushed." >&2; exit 1; }

GIT_SSH_COMMAND="$SSH_COMMAND" git -C "$ROOT" push origin "$@"
