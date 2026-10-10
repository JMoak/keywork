import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const documentRoutes = [
  {
    method: "GET",
    path: "/doc",
    operationId: "getDocument",
    summary: "This OpenAPI 3.1 document.",
    authenticated: false,
    responses: { "200": "The document." },
  },
] as const satisfies readonly RouteSpec[];

export const documentFamily = {
  routes: documentRoutes,
  handlers: (context) => ({
    getDocument: async () => json(200, context.describe()),
  }),
} satisfies RouteFamily<typeof documentRoutes>;
