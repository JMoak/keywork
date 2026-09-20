#!/bin/sh
set -eu

GITHUB_BASIC_AUTH=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
export GITHUB_BASIC_AUTH

exec caddy run --config /etc/git-broker/Caddyfile --adapter caddyfile
