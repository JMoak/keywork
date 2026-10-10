import { readFileSync, statSync } from "node:fs";
import type { ImagePart } from "@keywork/engine";

export interface PastedImage {
  readonly part: ImagePart;
  readonly bytes: number;
  readonly format: string;
}

export interface PasteFacts {
  readonly mimeType?: string | undefined;
  readonly kind?: "text" | "binary" | "unknown" | undefined;
  readonly bytes?: Uint8Array | undefined;
}

export type ImageFileReader = (path: string) => Uint8Array | undefined;

export type ClipboardRead =
  | { kind: "image"; image: PastedImage }
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "unsupported" };

export interface ClipboardPort {
  read(): Promise<ClipboardRead>;
}

export const maxImageBytes = 5 * 1024 * 1024;

export const imageMediaTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function imageFromPaste(
  text: string,
  facts: PasteFacts = {},
  readFile: ImageFileReader = readImageFile,
): PastedImage | undefined {
  const binary =
    facts.bytes !== undefined && facts.mimeType !== undefined
      ? imageFromBytes(facts.bytes, facts.mimeType)
      : undefined;
  if (binary !== undefined) return binary;
  const path = pastedPath(text);
  return path === undefined ? undefined : imageFromFile(path, readFile);
}

export function imageFromBytes(bytes: Uint8Array, mediaType: string): PastedImage | undefined {
  const format = formatOf(mediaType);
  if (format === undefined || bytes.byteLength === 0 || bytes.byteLength > maxImageBytes)
    return undefined;
  return {
    part: { type: "image", mediaType, data: Buffer.from(bytes).toString("base64") },
    bytes: bytes.byteLength,
    format,
  };
}

export function imageFromFile(
  path: string,
  readFile: ImageFileReader = readImageFile,
): PastedImage | undefined {
  const mediaType = imageMediaTypes[extensionOf(path)];
  if (mediaType === undefined) return undefined;
  const bytes = readFile(path);
  return bytes === undefined ? undefined : imageFromBytes(bytes, mediaType);
}

export function pastedPath(text: string): string | undefined {
  const line = text.trim();
  if (line === "" || line.includes("\n")) return undefined;
  const unquoted = line.replace(/^(['"])(.*)\1$/, "$2");
  const unescaped = unquoted.replace(/\\ /g, " ");
  const path = unescaped.startsWith("file://") ? fileUrlPath(unescaped) : unescaped;
  return path !== undefined && imageMediaTypes[extensionOf(path)] !== undefined ? path : undefined;
}

export function readImageFile(path: string): Uint8Array | undefined {
  const size = statSync(path, { throwIfNoEntry: false })?.size;
  if (size === undefined || size > maxImageBytes) return undefined;
  return readFileSync(path);
}

export function imageChip(ordinal: number, image: PastedImage): string {
  return `[image #${ordinal}, ${image.format} ${formatBytes(image.bytes)}]`;
}

export class ImageVault {
  private readonly held = new Map<number, PastedImage>();

  attach(image: PastedImage): string {
    const ordinal = this.held.size + 1;
    this.held.set(ordinal, image);
    return imageChip(ordinal, image);
  }

  imagesIn(text: string): ImagePart[] {
    return [...text.matchAll(chipPattern)]
      .map((match) => this.held.get(Number(match[1]))?.part)
      .filter((part): part is ImagePart => part !== undefined);
  }

  strip(text: string): string {
    return text.replace(chipPattern, (chip, ordinal: string) =>
      this.held.has(Number(ordinal)) ? "" : chip,
    );
  }

  clear(): void {
    this.held.clear();
  }

  snapshot(): ReadonlyMap<number, PastedImage> {
    return new Map(this.held);
  }

  restore(snapshot: ReadonlyMap<number, PastedImage>): void {
    this.held.clear();
    for (const [ordinal, image] of snapshot) this.held.set(ordinal, image);
  }
}

const chipPattern = /\[image #(\d+), \w+ [\d.]+ [KM]?B\]/g;

function formatOf(mediaType: string): string | undefined {
  return Object.entries(imageMediaTypes).find(([, mime]) => mime === mediaType)?.[0];
}

function extensionOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

function fileUrlPath(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return undefined;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
