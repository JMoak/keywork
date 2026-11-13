import type { QueuedPrompt } from "@keywork/engine";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export interface WorkPort {
  inFlight(): WorkInFlight;
  windDown(): Promise<WoundDown>;
}

export interface WorkInFlight {
  sessions: readonly SessionWork[];
  asks: number;
  children: number;
}

export interface SessionWork {
  id: string;
  title: string;
  working: boolean;
  queued: number;
  asks: number;
  children: number;
}

export interface WoundDown {
  sessions: readonly StoppedSession[];
  asks: number;
}

export interface StoppedSession {
  id: string;
  interrupted: boolean;
  setAside: readonly QueuedPrompt[];
}

export const nothingWoundDown: WoundDown = { sessions: [], asks: 0 };

export const workRoutes = [
  {
    method: "GET",
    path: "/work",
    operationId: "readWork",
    summary:
      "What is running or waiting in this server right now, read from memory alone so a client deciding whether it may quit can ask it cheaply. `sessions` lists only the sessions with something in flight, each `{ id, title, working, queued, asks, children }`: `working` is true while a turn runs, settles or has a prompt waiting in its queue (the same fact as `working` on `GET /sessions`), `queued` counts the prompts waiting, `asks` the asks pending on it, and `children` the delegated child sessions its turn is running. `asks` and `children` at the top count every pending ask and every running child in the server. Nothing in flight answers `{ sessions: [], asks: 0, children: 0 }` (since contract 1.32).",
    authenticated: true,
    responses: {
      "200": "`{ sessions, asks, children }`.",
      "503": "This host does not report its work.",
    },
  },
  {
    method: "POST",
    path: "/shutdown",
    operationId: "shutDown",
    summary:
      "Stop this server gracefully, the way an interrupt signal stops `keywork serve`, for a client that cannot send one (a desktop app on Windows, where killing the process loses what it held). Every running turn is interrupted and recorded with the outcome `shutdown`, keeping whatever text it had produced; prompts waiting in a queue are set aside and never run; pending asks are refused. The answer comes once all of it is written, and the process then closes its event streams, removes its ticket and exits. From the moment this route is called the server answers 503 to everything but reads and this route, so no new work starts. The answer lists what stopped: `sessions`, each `{ id, interrupted, setAside }` with `interrupted` true when a turn was ended and `setAside` the queued prompts as `queue.changed` carried them, so a client can offer them again; `asks` counts the asks refused. Calling it again while the server stops answers the same report (since contract 1.32).",
    authenticated: true,
    responses: {
      "200": "`{ sessions, asks }`; the process exits right after.",
      "503": "This server was not started by `keywork serve` and cannot stop itself.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const workFamily = {
  routes: workRoutes,
  handlers: ({ host, shutDown }) => ({
    readWork: async () =>
      host.work === undefined
        ? json(503, { error: "this host does not report its work" })
        : json(200, host.work.inFlight()),
    shutDown: async () =>
      shutDown === undefined
        ? json(503, { error: "this server cannot stop itself · stop the process that runs it" })
        : json(200, await shutDown()),
  }),
} satisfies RouteFamily<typeof workRoutes>;
