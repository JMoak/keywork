export {
  type CliOptions,
  type CliOutput,
  type CliRunner,
  cliTransport,
  defaultCliCommand,
  spawnCli,
} from "./cli.ts";
export {
  type EndpointSource,
  type LocalApiEndpoint,
  type LocalApiOptions,
  localApiHost,
  localApiTransport,
} from "./localapi.ts";
export {
  type PingFailure,
  type PingReply,
  type PingResult,
  parsePingJson,
  parsePingOutput,
} from "./ping.ts";
export {
  defaultTransport,
  discoverMacEndpoint,
  linuxSocketPath,
  type MacProbe,
  macSocketPath,
  systemMacProbe,
  type TransportPreferences,
  windowsPipePath,
} from "./select.ts";
export { parseServeConfig, type ServePosture } from "./serve-config.ts";
export {
  type BackendState,
  backendStates,
  isRunning,
  parseStatus,
  statusFingerprint,
  type TailnetInfo,
  type TailnetNode,
  type TailnetStatus,
  type TailnetUser,
  userOf,
} from "./status.ts";
export {
  createTailnet,
  defaultWhoisMaxAgeMs,
  type Tailnet,
  type TailnetOptions,
} from "./tailnet.ts";
export {
  isIPAddress,
  isLoopbackAddress,
  isTailnetAddress,
  isWildcardAddress,
  peerHost,
  tailnetIPv4Range,
  tailnetIPv6Range,
  tailnetRanges,
  urlHost,
} from "./tailnet-address.ts";
export { TailscaleFormatError } from "./tailscale-json.ts";
export {
  defaultPingTimeoutMs,
  defaultRequestTimeoutMs,
  type PingOptions,
  TailscaleError,
  type TailscaleTransport,
  TransportRefusedError,
  withFallback,
} from "./transport.ts";
export {
  isSharedIn,
  isTaggedNode,
  parseWhoIs,
  type WhoIs,
  type WhoIsNode,
  type WhoIsUser,
} from "./whois.ts";
