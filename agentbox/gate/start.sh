#!/bin/sh
set -eu

main() {
  allowed_domains | as_host_patterns > /tmp/allowed-hosts
  exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
}

allowed_domains() {
  sed -e 's/#.*//' -e 's/[[:space:]]//g' -e '/^$/d' /etc/gate/allowed-domains.txt
  printf '%s\n' ${GATE_EXTRA_DOMAINS:-} | sed '/^$/d'
}

as_host_patterns() {
  sed -e 's/\./\\./g' -e 's/^/(^|\\.)/' -e 's/$/$/'
}

main
