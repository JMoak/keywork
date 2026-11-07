import {
  CreatureProjectError,
  type CreatureProjectRefusal,
  projectDiscussionInput,
  projectDiscussionJsonSchema,
  projectThreadInput,
  projectThreadJsonSchema,
  projectWorkJsonSchema,
  projectWorkRequest,
} from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { bodyOf, json, type RouteFamily, type RouteSpec } from "./family.ts";

const refusals = {
  "400": "Invalid creature, project, request, or qualified session reference.",
  "403": "The project is not currently authorized for creature work.",
  "404": "The creature or selected project session is missing.",
  "409": "The project is unbound or the request ID was used for different work.",
  "503": "This host cannot serve the creature project context.",
} as const;

const projectPath = "/creatures/{slug}/projects/{project}";

export const creatureProjectRoutes = [
  {
    method: "GET",
    path: "/creatures/{slug}/projects",
    operationId: "listCreatureProjects",
    summary: "List the creature's authorized project bindings and their qualified threads.",
    authenticated: true,
    responses: { "200": "{ projects }", ...refusals },
  },
  {
    method: "PUT",
    path: projectPath,
    operationId: "bindCreatureProject",
    summary: "Associate an explicitly chosen, already authorized project with this creature.",
    authenticated: true,
    responses: { "200": "The project binding.", ...refusals },
  },
  {
    method: "DELETE",
    path: projectPath,
    operationId: "unbindCreatureProject",
    summary: "Remove the active association and retain the existing project session journals.",
    authenticated: true,
    responses: { "200": "The project is unbound.", ...refusals },
  },
  {
    method: "POST",
    path: `${projectPath}/threads`,
    operationId: "startCreatureProjectThread",
    summary:
      "Start a thread in the authorized project's runtime. Retry with the same request ID and input.",
    authenticated: true,
    requestBody: projectThreadJsonSchema,
    responses: { "202": "The qualified project session reference.", ...refusals },
  },
  {
    method: "POST",
    path: `${projectPath}/discussion`,
    operationId: "discussCreatureProjectSession",
    summary:
      "Send explicitly supplied text to the creature's home conversation and link the chosen project session.",
    authenticated: true,
    requestBody: projectDiscussionJsonSchema,
    responses: { "202": "The qualified home conversation reference.", ...refusals },
  },
  {
    method: "POST",
    path: "/creature-project-work",
    operationId: "receiveCreatureProjectWork",
    summary:
      "Run an authorized home creature request using this project's own session, tools and permission gate.",
    authenticated: true,
    requestBody: projectWorkJsonSchema,
    responses: { "202": "The qualified project session reference.", ...refusals },
  },
] as const satisfies readonly RouteSpec[];

export const creatureProjectFamily = {
  routes: creatureProjectRoutes,
  handlers: ({ host, log }) => {
    const projects = servedBy(() => host.creatureProjects, "creature projects");
    const work = servedBy(() => host.creatureProjectWork, "creature project work");
    const notify = (slug: string | undefined) => () => {
      if (slug !== undefined) log.record("", "creature.changed", { slug, change: "threads" });
    };
    return {
      listCreatureProjects: projects((port, _request, { slug }) =>
        projectResponse(200, async () => ({ projects: await port.list(slug ?? "") })),
      ),
      bindCreatureProject: projects((port, _request, { slug, project }) =>
        projectResponse(200, () => port.bind(slug ?? "", project ?? ""), notify(slug)),
      ),
      unbindCreatureProject: projects((port, _request, { slug, project }) =>
        projectResponse(
          200,
          async () => {
            await port.unbind(slug ?? "", project ?? "");
            return { unbound: true };
          },
          notify(slug),
        ),
      ),
      startCreatureProjectThread: projects(async (port, request, { slug, project }) => {
        const input = projectThreadInput.safeParse(await bodyOf(request));
        if (!input.success) return invalidBody();
        return projectResponse(
          202,
          async () => ({
            session: await port.run(slug ?? "", project ?? "", input.data),
          }),
          notify(slug),
        );
      }),
      discussCreatureProjectSession: projects(async (port, request, { slug, project }) => {
        const input = projectDiscussionInput.safeParse(await bodyOf(request));
        if (!input.success) return invalidBody();
        return projectResponse(
          202,
          async () => ({
            session: await port.discuss(slug ?? "", project ?? "", input.data),
          }),
          notify(slug),
        );
      }),
      receiveCreatureProjectWork: work(async (port, request) => {
        const input = projectWorkRequest.safeParse(await bodyOf(request));
        if (!input.success) return invalidBody();
        return projectResponse(202, async () => ({ session: await port.start(input.data) }));
      }),
    };
  },
} satisfies RouteFamily<typeof creatureProjectRoutes>;

const statusOf: Record<CreatureProjectRefusal, number> = {
  "bad-input": 400,
  "missing-creature": 404,
  "untrusted-project": 403,
  "unbound-project": 409,
  "missing-session": 404,
  "request-conflict": 409,
  unavailable: 503,
};

async function projectResponse(
  status: number,
  operation: () => Promise<unknown>,
  committed?: () => void,
): Promise<Response> {
  try {
    const result = await operation();
    committed?.();
    return json(status, result);
  } catch (cause) {
    if (!(cause instanceof CreatureProjectError)) throw cause;
    return json(statusOf[cause.code], { error: cause.message, code: cause.code });
  }
}

function invalidBody(): Response {
  return json(400, { error: "invalid creature project request", code: "bad-input" });
}
