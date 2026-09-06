export function extractSymbols(path: string, content: string): string[] {
  const extractor = extractors[extensionOf(path)];
  if (extractor === undefined) return [];
  return unique(extractor(content));
}

export function referencedIdentifiers(content: string): Set<string> {
  return new Set(content.match(identifier) ?? []);
}

export function mappableFile(path: string): boolean {
  return extractors[extensionOf(path)] !== undefined;
}

const identifier = /[A-Za-z_$][\w$]*/g;

type Extractor = (content: string) => string[];

const extractors: Record<string, Extractor | undefined> = {
  ts: extractTypeScript,
  tsx: extractTypeScript,
  js: extractTypeScript,
  jsx: extractTypeScript,
  mjs: extractTypeScript,
  cjs: extractTypeScript,
  py: extractPython,
  go: extractGo,
  rs: extractRust,
  md: extractMarkdownHeadings,
};

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

function extractTypeScript(content: string): string[] {
  return [
    ...allCaptures(
      content,
      /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
    ),
    ...exportListNames(content),
    ...allCaptures(content, /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm),
  ];
}

function exportListNames(content: string): string[] {
  return allCaptures(content, /^export\s*\{([^}]*)\}/gm).flatMap((list) =>
    list
      .split(",")
      .map(
        (entry) =>
          entry
            .trim()
            .split(/\s+as\s+/)
            .at(-1) ?? "",
      )
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)),
  );
}

function extractPython(content: string): string[] {
  return allCaptures(content, /^(?:def|class)\s+([A-Za-z_]\w*)/gm).filter(
    (name) => !name.startsWith("_"),
  );
}

function extractGo(content: string): string[] {
  return [
    ...allCaptures(content, /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm),
    ...allCaptures(content, /^type\s+([A-Z]\w*)/gm),
    ...allCaptures(content, /^(?:var|const)\s+([A-Z]\w*)/gm),
  ];
}

function extractRust(content: string): string[] {
  return allCaptures(
    content,
    /^\s*pub\s+(?:async\s+|unsafe\s+|const\s+)*(?:fn|struct|enum|trait|mod|const|static|type)\s+([A-Za-z_]\w*)/gm,
  );
}

function extractMarkdownHeadings(content: string): string[] {
  return allCaptures(content, /^#{1,6}\s+(.+?)\s*$/gm);
}

function allCaptures(content: string, pattern: RegExp): string[] {
  return [...content.matchAll(pattern)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "");
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}
