import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const fixture = (name) =>
  readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8");

const whoisFixtures = {
  "100.101.102.103": "whois-self",
  "fd7a:115c:a1e0::6566:6767": "whois-self",
  "100.88.77.66": "whois-peer",
  "fd7a:115c:a1e0::5841:4d42": "whois-peer-v6",
};

if (process.env.FAKE_TAILSCALE_LOG) {
  appendFileSync(process.env.FAKE_TAILSCALE_LOG, `${JSON.stringify(argv)}\n`);
}

const [command, ...rest] = argv;
const last = rest.at(-1) ?? "";

if (command === "status" && rest.includes("--json")) {
  process.stdout.write(fixture(process.env.FAKE_TAILSCALE_STATUS ?? "status-running"));
} else if (command === "whois" && rest.includes("--json")) {
  const name = whoisFixtures[last];
  if (name === undefined) {
    process.stderr.write("peer not found\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(fixture(name));
  }
} else if (command === "ping") {
  if (last === "100.88.77.66") {
    process.stdout.write("pong from host (100.88.77.66) via 192.168.1.30:41641 in 2ms\n");
  } else {
    process.stderr.write("no matching peer\n");
    process.exitCode = 1;
  }
} else if (command === "serve" && rest[0] === "status") {
  process.stdout.write("{}\n");
} else {
  process.stderr.write(`fake tailscale does not know ${argv.join(" ")}\n`);
  process.exitCode = 2;
}
