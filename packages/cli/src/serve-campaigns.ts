import { join } from "node:path";
import {
  askGateUnconfined,
  CampaignArtifacts,
  CampaignCartridges,
  CampaignService,
  CampaignSources,
  CampaignStore,
  campaignDatabase,
  campaignExecutor,
  loadProjectInstructions,
  OpenRouterQuoteCache,
  type PermissionResolver,
  type Provider,
  type SkillDefinition,
  sandboxFor,
  type ToolGuard,
  toolScope,
  workspaceSandbox,
} from "@keywork/engine";
import type { SessionInference } from "@keywork/server";

export interface ServedCampaignOptions {
  root: string;
  workspace: string;
  ownerScope: string;
  sessionRoot: string;
  trusted(): boolean;
  provider: Provider;
  inference?: SessionInference | undefined;
  skills: readonly SkillDefinition[];
  permissions: PermissionResolver;
  guardFor(sessionId: string, signal?: AbortSignal): ToolGuard;
  closeAsks(sessionId: string): void;
  notice(message: string): void;
}

export async function servedCampaigns(options: ServedCampaignOptions): Promise<CampaignService> {
  const artifacts = new CampaignArtifacts(join(options.root, "artifacts"));
  const cartridges = new CampaignCartridges({
    root: join(options.root, "cartridges"),
    skills: options.skills,
  });
  const store = await CampaignStore.open(campaignDatabase(options.root));
  const sources = new CampaignSources(
    join(options.root, "sources"),
    artifacts,
    (ownerScope, source) =>
      options.trusted() && ownerScope === options.ownerScope && source.ownerScope === ownerScope,
  );
  const executor = campaignExecutor({
    artifacts,
    cartridges,
    sources,
    quotes: new OpenRouterQuoteCache(),
    sessionRoot: options.sessionRoot,
    trusted: options.trusted,
    permissions: options.permissions,
    guardFor: options.guardFor,
    closeAsks: options.closeAsks,
    instructions: async () =>
      options.trusted()
        ? ((await loadProjectInstructions(options.workspace)) ?? "")
        : Promise.reject(new Error("Workspace trust is required")),
    provider: (model) => {
      if (options.inference !== undefined) {
        const resolved = options.inference.bind(`${model.providerId}/${model.modelId}`);
        if (!resolved.ok) throw new Error(resolved.failure.message);
        return options.inference.provider(resolved.binding);
      }
      if (options.provider.name !== model.providerId || options.provider.modelId !== model.modelId)
        throw new Error("The selected campaign model is not configured in this runtime");
      return options.provider;
    },
    sandbox: async (directory, guard) =>
      workspaceSandbox(await sandboxFor("isolated", toolScope(directory))).forAgent(
        askGateUnconfined(guard, { say: options.notice }),
      ),
  });
  const campaigns = new CampaignService({
    store,
    artifacts,
    cartridges,
    sources,
    executor,
    workspace: options.workspace,
    ownerScope: options.ownerScope,
    trusted: options.trusted,
    notice: options.notice,
  });
  campaigns.recover();
  return campaigns;
}
