import type { AfterSave } from "../tools/after-save.ts";
import { diagnosticsBlock } from "./format.ts";
import type { LanguagePort } from "./port.ts";

export interface DiagnosticsPublication {
  path: string;
  count: number;
}

export interface DiagnosticsObserverOptions {
  cwd: string;
  onPublished?: ((publication: DiagnosticsPublication) => void) | undefined;
}

export function diagnosticsObserver(
  port: LanguagePort,
  options: DiagnosticsObserverOptions,
): AfterSave {
  return async (path, signal) => {
    const language = port.languageOf(path);
    if (language === undefined) return undefined;
    const diagnostics = await port.afterSave(path, signal);
    if (serverReady(port, language)) {
      options.onPublished?.({ path, count: diagnostics.length });
    }
    return diagnosticsBlock(language, diagnostics, options.cwd);
  };
}

function serverReady(port: LanguagePort, language: string): boolean {
  return port
    .facts()
    .servers.some((server) => server.language === language && server.state === "ready");
}
