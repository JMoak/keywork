import { contractVersion } from "../contract.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const documentRoutes = [
  {
    method: "GET",
    path: "/doc",
    operationId: "getDocument",
    summary:
      "This OpenAPI 3.1 document. `info.version` is the keywork release; `info.x-keywork-contract` (also the `x-keywork-contract` response header) is the HTTP and SSE contract version a client checks before it trusts the rest.",
    authenticated: false,
    responses: { "200": "The document." },
  },
] as const satisfies readonly RouteSpec[];

export const documentFamily = {
  routes: documentRoutes,
  handlers: (context) => ({
    getDocument: async () => withContractHeader(json(200, context.describe())),
  }),
} satisfies RouteFamily<typeof documentRoutes>;

function withContractHeader(response: Response): Response {
  response.headers.set("x-keywork-contract", contractVersion);
  return response;
}
