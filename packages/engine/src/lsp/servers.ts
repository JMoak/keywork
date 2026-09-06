import { extname } from "node:path";

export interface LanguageServerSpec {
  command: readonly string[];
  extensions: readonly string[];
  initialization?: Readonly<Record<string, unknown>> | undefined;
}

export type LanguageServerTable = Readonly<Record<string, LanguageServerSpec>>;

export type LanguageServerSetting = "off" | "auto" | LanguageServerTable;

export const builtInLanguageServers: LanguageServerTable = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  },
  python: { command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  go: { command: ["gopls"], extensions: [".go"] },
  rust: { command: ["rust-analyzer"], extensions: [".rs"] },
};

export function languageServersFor(
  setting: LanguageServerSetting | undefined,
): LanguageServerTable {
  if (setting === undefined || setting === "off") return {};
  if (setting === "auto") return builtInLanguageServers;
  return { ...builtInLanguageServers, ...setting };
}

export function languageOf(servers: LanguageServerTable, path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === "") return undefined;
  return Object.entries(servers).find(([, spec]) => spec.extensions.includes(extension))?.[0];
}

const languageIdsByExtension: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
};

export function languageIdFor(language: string, path: string): string {
  return languageIdsByExtension[extname(path).toLowerCase()] ?? language;
}
