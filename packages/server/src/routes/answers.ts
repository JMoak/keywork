import {
  ArcExistsError,
  ArcNotActiveError,
  McpRegistryClosedError,
  McpServerNotFoundError,
  MissingArcError,
} from "@keywork/engine";
import { BlanketTrustError, InvalidSlugError } from "@keywork/shared";
import type { EventLog } from "../events.ts";
import {
  BinaryFileError,
  FileTooLargeError,
  MissingPathError,
  WorkspaceScopeError,
} from "../files.ts";
import { SessionBusyError, SurfaceUnavailableError, TrustRefusedError } from "../host.ts";
import { json, type RouteHandler, type RouteParams } from "./family.ts";

export type SurfaceKind = "mcp" | "arcs" | "bots" | "workspaces" | "permissions";

export type PortHandler<Port> = (
  port: Port,
  request: Request,
  params: RouteParams,
) => Promise<Response>;

export function servedBy<Port>(
  port: () => Port | undefined,
  what: string,
): (handle: PortHandler<Port>) => RouteHandler {
  return (handle) =>
    answering(async (request, params) => {
      const served = port();
      return served === undefined ? unserved(what) : handle(served, request, params);
    });
}

export function answering(handle: RouteHandler): RouteHandler {
  return async (request, params) => {
    try {
      return await handle(request, params);
    } catch (cause) {
      const refusal = refusalOf(cause);
      if (refusal === undefined) throw cause;
      return refusal;
    }
  };
}

export function unserved(what: string): Response {
  return json(503, { error: `${what} is not served by this host` });
}

export function surfaceChanged(log: EventLog, kind: SurfaceKind): void {
  log.record("", "surface.changed", { kind });
}

type ErrorKind = abstract new (...args: never[]) => Error;

const refusalStatuses: ReadonlyArray<readonly [kind: ErrorKind, status: number]> = [
  [BlanketTrustError, 400],
  [InvalidSlugError, 400],
  [WorkspaceScopeError, 403],
  [SurfaceUnavailableError, 403],
  [MissingPathError, 404],
  [McpServerNotFoundError, 404],
  [MissingArcError, 404],
  [SessionBusyError, 409],
  [TrustRefusedError, 409],
  [ArcExistsError, 409],
  [ArcNotActiveError, 409],
  [FileTooLargeError, 413],
  [BinaryFileError, 415],
  [McpRegistryClosedError, 503],
];

const plainRefusalStatus = 409;

function refusalOf(cause: unknown): Response | undefined {
  if (!(cause instanceof Error)) return undefined;
  const listed = refusalStatuses.find(([kind]) => cause instanceof kind);
  if (listed !== undefined) return json(listed[1], { error: cause.message });
  const plain = Object.getPrototypeOf(cause) === Error.prototype;
  return plain ? json(plainRefusalStatus, { error: cause.message }) : undefined;
}
