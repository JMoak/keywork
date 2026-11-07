export class PolicyTextError extends Error {
  override readonly name = "PolicyTextError";
}

export function parseHuJson(text: string): unknown {
  const json = withoutTrailingCommas(withoutComments(text));
  try {
    return JSON.parse(json);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyTextError(`the policy is not JSON or HuJSON: ${detail}`, { cause });
  }
}

function withoutComments(text: string): string {
  let kept = "";
  let at = 0;
  while (at < text.length) {
    const next = text.slice(at, at + 2);
    if (text[at] === '"') {
      const end = endOfString(text, at);
      kept += text.slice(at, end);
      at = end;
    } else if (next === "//") {
      at = indexOrEnd(text, "\n", at);
    } else if (next === "/*") {
      const close = indexOrEnd(text, "*/", at + 2);
      kept += blankedKeepingLines(text.slice(at, close + 2));
      at = close + 2;
    } else {
      kept += text[at];
      at += 1;
    }
  }
  return kept;
}

function withoutTrailingCommas(json: string): string {
  let kept = "";
  let at = 0;
  while (at < json.length) {
    if (json[at] === '"') {
      const end = endOfString(json, at);
      kept += json.slice(at, end);
      at = end;
      continue;
    }
    if (json[at] !== "," || !closesNext(json, at + 1)) kept += json[at];
    at += 1;
  }
  return kept;
}

function endOfString(text: string, open: number): number {
  let at = open + 1;
  while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
  return Math.min(at + 1, text.length);
}

function closesNext(json: string, from: number): boolean {
  const rest = json.slice(from).trimStart();
  return rest.startsWith("}") || rest.startsWith("]");
}

function indexOrEnd(text: string, needle: string, from: number): number {
  const found = text.indexOf(needle, from);
  return found === -1 ? text.length : found;
}

function blankedKeepingLines(comment: string): string {
  return comment.replace(/[^\n]/g, " ");
}
