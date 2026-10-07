import { describe, expect, it } from "vitest";
import {
  type ImageFileReader,
  ImageVault,
  imageChip,
  imageFromBytes,
  imageFromFile,
  imageFromPaste,
  maxImageBytes,
  type PastedImage,
  pastedPath,
} from "./image-paste.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function disk(files: Record<string, Uint8Array>): ImageFileReader {
  return (path) => files[path];
}

describe("pastedPath", () => {
  it("accepts a bare, quoted, escaped or file:// image path on one line", () => {
    expect(pastedPath("C:\\shots\\one.png")).toBe("C:\\shots\\one.png");
    expect(pastedPath('"C:\\shots\\one.PNG"')).toBe("C:\\shots\\one.PNG");
    expect(pastedPath("'/home/j/a.jpg'")).toBe("/home/j/a.jpg");
    expect(pastedPath("/home/j/my\\ shot.webp")).toBe("/home/j/my shot.webp");
    expect(pastedPath("file:///home/j/a.gif")).toBe("/home/j/a.gif");
    expect(pastedPath("file:///C:/shots/a%20b.jpeg")).toBe("C:/shots/a b.jpeg");
  });

  it("leaves prose, multi-line text and non-image paths alone", () => {
    expect(pastedPath("look at one.png please")).toBeUndefined();
    expect(pastedPath("a.png\nb.png")).toBeUndefined();
    expect(pastedPath("notes.md")).toBeUndefined();
    expect(pastedPath("")).toBeUndefined();
  });
});

describe("imageFromPaste", () => {
  it("reads an image file named by the pasted path", () => {
    const image = imageFromPaste("/shots/one.png", {}, disk({ "/shots/one.png": png }));
    expect(image).toMatchObject({ bytes: 8, format: "png" });
    expect(image?.part).toEqual({
      type: "image",
      mediaType: "image/png",
      data: Buffer.from(png).toString("base64"),
    });
  });

  it("prefers binary image bytes the terminal hands over", () => {
    const image = imageFromPaste("", { mimeType: "image/jpeg", kind: "binary", bytes: png });
    expect(image).toMatchObject({ format: "jpg", bytes: 8 });
  });

  it("falls through to plain text when the path is missing or not an image", () => {
    expect(imageFromPaste("/shots/gone.png", {}, disk({}))).toBeUndefined();
    expect(imageFromPaste("hello", {}, disk({}))).toBeUndefined();
    expect(imageFromPaste("", { mimeType: "text/plain", bytes: png })).toBeUndefined();
  });
});

describe("imageFromBytes and imageFromFile", () => {
  it("refuses empty, oversized or unknown media", () => {
    expect(imageFromBytes(new Uint8Array(0), "image/png")).toBeUndefined();
    expect(imageFromBytes(new Uint8Array(maxImageBytes + 1), "image/png")).toBeUndefined();
    expect(imageFromBytes(png, "image/bmp")).toBeUndefined();
    expect(imageFromFile("/shots/one.bmp", disk({ "/shots/one.bmp": png }))).toBeUndefined();
  });
});

describe("ImageVault", () => {
  const image: PastedImage = {
    part: { type: "image", mediaType: "image/png", data: "AAAA" },
    bytes: 24 * 1024,
    format: "png",
  };

  it("numbers chips, resolves them in order and strips them from the sent text", () => {
    const vault = new ImageVault();
    const first = vault.attach(image);
    const second = vault.attach({ ...image, bytes: 3 * 1024 * 1024, format: "jpg" });
    expect(first).toBe("[image #1, png 24 KB]");
    expect(second).toBe("[image #2, jpg 3.0 MB]");
    const text = `${second} describe ${first}`;
    expect(vault.imagesIn(text)).toEqual([image.part, image.part]);
    expect(vault.strip(text).trim()).toBe("describe");
  });

  it("leaves a chip it never minted as literal text", () => {
    const vault = new ImageVault();
    expect(vault.strip("[image #9, png 1 KB]")).toBe("[image #9, png 1 KB]");
    expect(vault.imagesIn("[image #9, png 1 KB]")).toEqual([]);
  });

  it("snapshots and restores so a cleared draft keeps its images", () => {
    const vault = new ImageVault();
    const chip = vault.attach(image);
    const snapshot = vault.snapshot();
    vault.clear();
    expect(vault.imagesIn(chip)).toEqual([]);
    vault.restore(snapshot);
    expect(vault.imagesIn(chip)).toEqual([image.part]);
  });

  it("formats sizes in bytes, kilobytes and megabytes", () => {
    expect(imageChip(1, { ...image, bytes: 512 })).toBe("[image #1, png 512 B]");
    expect(imageChip(2, { ...image, bytes: 2048 })).toBe("[image #2, png 2 KB]");
  });
});
