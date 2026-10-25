import type { Agent, Message } from "@keywork/engine";
import type { AppendReceipt, SessionAttachment } from "./session-attachment.ts";

export interface SessionWriterHooks {
  promptSaved(entryId: string): void;
  modelReference(agent: Agent): string | undefined;
}

export class SessionWriter {
  private persisted: number;
  private modelRecorded: boolean;
  private openPrompt: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly attachment: SessionAttachment,
    private readonly hooks: SessionWriterHooks,
  ) {
    this.persisted = attachment.history.length;
    this.modelRecorded = attachment.modelReference !== undefined;
  }

  rebase(length: number): void {
    this.persisted = length;
  }

  openTurn(agent: Agent): Promise<void> {
    if (this.attachment.openTurn === undefined) return Promise.resolve();
    return this.serially(async () => {
      this.openPrompt = (await this.saveUnsaved(agent)) ?? this.openPrompt;
    });
  }

  persist(agent: Agent): Promise<void> {
    return this.serially(async () => {
      await this.saveUnsaved(agent);
    });
  }

  settleTurn(agent: Agent): Promise<void> {
    return this.serially(async () => {
      await this.saveUnsaved(agent);
      const prompt = this.openPrompt;
      this.openPrompt = undefined;
      if (prompt !== undefined) await this.attachment.settleTurn?.(prompt);
    });
  }

  private serially(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async saveUnsaved(agent: Agent): Promise<string | undefined> {
    const history = agent.history();
    if (history.length > this.persisted) await this.recordModelOnce(agent);
    let prompt: string | undefined;
    while (this.persisted < history.length) {
      const message = history[this.persisted];
      if (message === undefined) break;
      const receipt = await this.save(message);
      this.persisted += 1;
      if (message.role !== "user" || receipt === undefined) continue;
      this.hooks.promptSaved(receipt.entryId);
      prompt ??= receipt.entryId;
    }
    return prompt;
  }

  private save(message: Message): Promise<AppendReceipt | undefined> {
    if (message.role === "user" && this.attachment.openTurn !== undefined) {
      return this.attachment.openTurn(message);
    }
    return this.attachment.append(message);
  }

  private async recordModelOnce(agent: Agent): Promise<void> {
    if (this.modelRecorded) return;
    this.modelRecorded = true;
    const reference = this.hooks.modelReference(agent);
    if (reference !== undefined) await this.attachment.recordModel?.(reference);
  }
}
