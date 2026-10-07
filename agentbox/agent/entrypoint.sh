#!/usr/bin/env bash
set -euo pipefail

readonly base_config=/etc/agentbox/keywork.json
readonly house_rules=/etc/agentbox/house-rules.md
readonly systems_dir=/etc/agentbox/systems
readonly user_config="$HOME/.keywork/keywork.json"

main() {
  write_user_config
  write_git_config
  clone_workspace_if_asked
  keywork trust > /dev/null
  wait_for_systems
  exec "$@"
}

write_user_config() {
  local fragments
  fragments=$(config_fragments)
  mkdir -p "$(dirname "$user_config")"
  jq --slurp \
     --rawfile rules "$house_rules" \
     --arg model "${AGENT_MODEL:-}" \
     'reduce .[] as $fragment ({}; (. * $fragment)
        + {permissions: ((.permissions // []) + ($fragment.permissions // []))})
      | .prompts.system = $rules
      | if $model == "" then . else .model = $model end' \
     $fragments > "$user_config"
}

config_fragments() {
  echo "$base_config"
  local system
  for system in $(enabled_systems); do
    require_file "$systems_dir/$system/keywork.json"
  done
}

write_git_config() {
  local system
  git config --global --replace-all safe.directory /workspace
  git config --global --unset-all include.path || true
  for system in $(enabled_systems); do
    if [[ -f "$systems_dir/$system/gitconfig" ]]; then
      git config --global --add include.path "$systems_dir/$system/gitconfig"
    fi
  done
}

clone_workspace_if_asked() {
  if [[ -n "${REPO_URL:-}" && ! -d /workspace/.git ]]; then
    git clone "$REPO_URL" /workspace
  fi
}

wait_for_systems() {
  local system
  for system in $(enabled_systems); do
    wait_for_port "$system.box" 8080
  done
}

wait_for_port() {
  local attempt
  for attempt in $(seq 60); do
    if (exec 3<> "/dev/tcp/$1/$2") 2> /dev/null; then return; fi
    sleep 1
  done
  echo "agentbox: gave up waiting for $1:$2" >&2
  exit 1
}

enabled_systems() {
  echo "${AGENTBOX_SYSTEMS//,/ }"
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "agentbox: COMPOSE_PROFILES names a system with no $1" >&2
    exit 1
  fi
  echo "$1"
}

main "$@"
