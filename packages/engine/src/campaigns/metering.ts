import { createHash, randomUUID } from "node:crypto";
import type { ModelSelection } from "@keywork/campaigns";
import type { Usage } from "../messages.ts";
import {
  assertRequestControls,
  type DoneDelta,
  type Provider,
  type ProviderRequest,
  type ProviderResponseReceipt,
  type TurnDelta,
} from "../provider.ts";
import {
  type CampaignRequestBound,
  campaignRequestBound,
  estimatedCampaignMicros,
  type OpenRouterCampaignQuote,
  reportedCampaignMicros,
} from "./pricing.ts";
import type { CampaignLease, CampaignOperationIntent, CampaignStore } from "./store.ts";

export interface MeteredCampaignProviderOptions {
  provider: Provider;
  store: CampaignStore;
  lease: () => CampaignLease;
  campaignId: string;
  attemptId: string | null;
  stage: CampaignOperationIntent["stage"];
  quote: OpenRouterCampaignQuote;
  maxOutputTokens: number;
  now?: () => number;
  operationId?: () => string;
  authorize?: () => boolean;
  onOperation?: (
    operationId: string,
    request: ProviderRequest,
    bound: CampaignRequestBound,
  ) => void | Promise<void>;
}

export class CampaignMeteringError extends Error {
  constructor(
    readonly operationId: string | null,
    message: string,
  ) {
    super(message);
    this.name = "CampaignMeteringError";
  }
}

export function meteredCampaignProvider(options: MeteredCampaignProviderOptions): Provider {
  return {
    name: options.provider.name,
    modelId: options.provider.modelId,
    capabilities: options.provider.capabilities,
    requestSupport: options.provider.requestSupport,
    stream: (request) => meteredStream(options, request),
  };
}

async function* meteredStream(
  options: MeteredCampaignProviderOptions,
  request: ProviderRequest,
): AsyncGenerator<TurnDelta> {
  const now = options.now ?? Date.now;
  const { quote, store, provider } = options;
  if (quote.quotedAt > now() || quote.expiresAt <= now())
    throw new CampaignMeteringError(null, "Campaign quote expired; refresh before dispatch");
  if (provider.modelId !== quote.modelId)
    throw new CampaignMeteringError(
      null,
      "Resolved provider model does not match the admitted quote",
    );
  const capped: ProviderRequest = {
    ...request,
    maxOutputTokens: Math.min(
      options.maxOutputTokens,
      request.maxOutputTokens ?? options.maxOutputTokens,
    ),
    retry: "never",
    openRouterRouting: quote.routing,
  };
  assertRequestControls(provider, capped);
  const bound = campaignRequestBound(
    capped,
    quote,
    capped.maxOutputTokens ?? options.maxOutputTokens,
  );
  const id = (options.operationId ?? randomUUID)();
  await options.onOperation?.(id, capped, bound);
  assertAuthorized(options, request, id);
  if (quote.expiresAt <= now())
    throw new CampaignMeteringError(id, "Campaign quote expired while preparing context");
  const campaign = store.read(options.campaignId);
  if (campaign === undefined) throw new CampaignMeteringError(id, "Campaign no longer exists");
  const model: ModelSelection = {
    ...campaign.model,
    providerId: provider.name,
    modelId: quote.modelId,
  };
  const operation = store.reserve(
    {
      id,
      campaignId: options.campaignId,
      attemptId: options.attemptId,
      stage: options.stage,
      model,
      maximumMicros: bound.maximumMicros,
      pricing: quote.sourceUrl,
      pricingAt: quote.quotedAt,
      request: {
        digest: requestDigest(capped),
        inputTokenBound: bound.inputTokens,
        maxOutputTokens: capped.maxOutputTokens,
        providerTag: quote.providerTag,
        boundProvenance: bound.provenance,
        quote,
      },
    },
    options.lease(),
  );
  if (operation.state !== "reserved")
    throw new CampaignMeteringError(
      id,
      "Operation already dispatched; reconcile its existing outcome before another attempt",
    );
  let dispatched = false;
  let accounted = false;
  let observed: ProviderResponseReceipt | undefined;
  try {
    assertAuthorized(options, request, id);
    store.dispatch(id, options.lease());
    dispatched = true;
    const inner: ProviderRequest = {
      ...capped,
      onResponse: (receipt) => {
        observed = { ...observed, ...receipt };
        store.observeResponse(
          id,
          {
            ...observed,
            ...(observed.costUsd !== undefined && {
              costMicros: reportedCampaignMicros(observed.costUsd),
            }),
          },
          options.lease(),
        );
        request.onResponse?.(receipt);
      },
    };
    assertAuthorized(options, request, id);
    for await (const delta of provider.stream(inner)) {
      if (delta.type !== "done") {
        yield delta;
        continue;
      }
      const receipt = delta.receipt === undefined ? observed : { ...observed, ...delta.receipt };
      if (receipt !== undefined)
        store.observeResponse(
          id,
          {
            ...receipt,
            ...(delta.usage.costUsd !== undefined && {
              costMicros: reportedCampaignMicros(delta.usage.costUsd),
            }),
          },
          options.lease(),
        );
      assertComplete(id, quote, delta, receipt);
      const totalInput = inputTokens(delta.usage);
      const reported = delta.usage.costUsd !== undefined;
      const costMicros = reported
        ? reportedCampaignMicros(delta.usage.costUsd ?? 0)
        : estimatedCampaignMicros(quote, delta.usage);
      store.settle(
        id,
        {
          ...operation.receipt,
          providerRequestId: receipt?.responseId ?? receipt?.requestId ?? null,
          state: reported ? "reported" : "estimated",
          costMicros,
          costSource: reported
            ? "OpenRouter streamed usage.cost"
            : `${quote.sourceUrl} (token-rate estimate; reservation retained)`,
          recordedAt: now(),
          inputTokens: totalInput,
          outputTokens: delta.usage.outputTokens,
          cachedTokens: delta.usage.cacheReadInputTokens ?? 0,
        },
        options.lease(),
      );
      accounted = true;
      if (
        totalInput > bound.inputTokens ||
        delta.usage.outputTokens > (capped.maxOutputTokens ?? 0) ||
        costMicros > bound.maximumMicros
      )
        throw new CampaignMeteringError(
          id,
          "Provider usage exceeded the reserved bound; recorded the charge and stopped execution",
        );
      yield { ...delta, ...(receipt !== undefined && { receipt }) };
      return;
    }
    throw new CampaignMeteringError(id, "Provider stream ended without a complete usage receipt");
  } catch (cause) {
    if (dispatched && !accounted)
      retainUnknown(
        store,
        id,
        options.lease,
        "Provider outcome is incomplete; reconcile before retrying",
      );
    if (!dispatched) releaseUndispatched(store, id, options.lease);
    throw cause;
  } finally {
    if (dispatched && !accounted && store.operation(id)?.state === "dispatched")
      retainUnknown(
        store,
        id,
        options.lease,
        "Provider stream closed before its outcome was recorded",
      );
  }
}

function assertAuthorized(
  options: MeteredCampaignProviderOptions,
  request: ProviderRequest,
  id: string,
): void {
  request.signal?.throwIfAborted();
  if (options.authorize?.() === false)
    throw new CampaignMeteringError(id, "Campaign dispatch authority was revoked");
}

function assertComplete(
  id: string,
  quote: OpenRouterCampaignQuote,
  delta: DoneDelta,
  receipt: ProviderResponseReceipt | undefined,
): void {
  if (
    receipt?.usageReported !== true ||
    !["stop", "length", "tool_calls", "function_call"].includes(receipt.finishReason ?? "")
  )
    throw new CampaignMeteringError(
      id,
      "Provider terminal marker or usage is missing; outcome requires reconciliation",
    );
  if (
    receipt.requestedModel !== quote.modelId ||
    receipt.servedModel !== quote.modelId ||
    receipt.servedProvider !== quote.providerName
  )
    throw new CampaignMeteringError(
      id,
      "Served model or provider identity does not match the admitted route",
    );
  if (!receipt.responseId && !receipt.requestId)
    throw new CampaignMeteringError(
      id,
      "Provider returned no durable request or generation identity",
    );
  const counts = [
    delta.usage.inputTokens,
    delta.usage.outputTokens,
    delta.usage.cacheReadInputTokens ?? 0,
    delta.usage.cacheCreationInputTokens ?? 0,
  ];
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    !Number.isSafeInteger(inputTokens(delta.usage))
  )
    throw new CampaignMeteringError(id, "Provider usage counters are invalid");
}

function inputTokens(usage: Usage): number {
  return (
    usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
  );
}

function requestDigest(request: ProviderRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
        maxOutputTokens: request.maxOutputTokens,
        routing: request.openRouterRouting,
      }),
    )
    .digest("hex");
}

function retainUnknown(
  store: CampaignStore,
  id: string,
  lease: () => CampaignLease,
  reason: string,
): void {
  try {
    store.unknown(id, reason, lease());
  } catch {
    return;
  }
}

function releaseUndispatched(store: CampaignStore, id: string, lease: () => CampaignLease): void {
  if (store.operation(id)?.state !== "reserved") return;
  try {
    store.releaseReservation(id, lease());
  } catch {
    return;
  }
}
