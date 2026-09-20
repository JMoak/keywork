#!/usr/bin/env bash
# Proves, from inside the agent container, that the box is sealed and wired.
set -uo pipefail

failures=0

main() {
  section "the gate"
  check "an allowlisted domain is reachable" reaches https://pypi.org/simple/
  check "any other domain is refused" not reaches https://example.com
  check "there is no route around the gate" not reaches_directly https://pypi.org/simple/

  section "credentials"
  check "the environment holds no secret" no_secrets_in_environment

  section "the workspace"
  check "/workspace is writable" writable /workspace
  if [[ -z "${REPO_URL:-}" ]]; then
    check ".git/config is read-only" not appendable /workspace/.git/config
    check ".git/hooks is read-only" not writable /workspace/.git/hooks
  fi

  section "systems"
  for system in ${AGENTBOX_SYSTEMS//,/ }; do
    check "$system answers on $system.box:8080" listening "$system.box" 8080
  done
  if [[ -f /etc/agentbox/systems/github/gitconfig && ",$AGENTBOX_SYSTEMS," == *,github,* ]]; then
    check "git reaches origin through the broker" git -C /workspace ls-remote --exit-code origin HEAD
  fi
  if [[ -n "${AGENTBOX_MODEL_BROKER:-}" ]]; then
    check "the model broker answers" listening "${AGENTBOX_MODEL_BROKER%%:*}" "${AGENTBOX_MODEL_BROKER##*:}"
  fi

  section "toolchain"
  mise ls 2> /dev/null | sed 's/^/     /'

  echo
  if ((failures > 0)); then
    echo "$failures check(s) failed."
    exit 1
  fi
  echo "All checks passed."
}

section() {
  echo
  echo "$1"
}

check() {
  local label=$1
  shift
  if "$@" > /dev/null 2>&1; then
    echo "  ok   $label"
  else
    echo "  FAIL $label"
    failures=$((failures + 1))
  fi
}

not() {
  ! "$@"
}

reaches() {
  curl --silent --show-error --fail --max-time 15 --output /dev/null "$1"
}

reaches_directly() {
  curl --noproxy '*' --silent --fail --max-time 5 --output /dev/null "$1"
}

no_secrets_in_environment() {
  local known=" ${AGENTBOX_KNOWN_SECRETS:-} "
  local name value
  while IFS='=' read -r name value; do
    [[ "$name" =~ (TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY) ]] || continue
    [[ -z "$value" || "$value" == brokered || "$known" == *" $name "* ]] || return 1
  done < <(env)
}

writable() {
  local probe="$1/.agentbox-probe"
  touch "$probe" && rm -f "$probe"
}

appendable() {
  [[ -w "$1" ]] && : >> "$1"
}

listening() {
  (exec 3<> "/dev/tcp/$1/$2")
}

main
