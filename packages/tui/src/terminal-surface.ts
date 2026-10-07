import { EmbeddedTerminalRenderable, KeyEvent, type RenderContext } from "@opentui/core";
import type { Chord } from "./keys.ts";
import type { PaneChild } from "./pane-chrome.ts";
import type { TerminalSize } from "./terminal-backend.ts";

export interface TerminalSurface {
  feed(bytes: Uint8Array): void;
  encodeKey(chord: Chord, sequence: string | undefined): Uint8Array;
  encodePaste(text: string): Uint8Array;
  resize(size: TerminalSize): void;
  setFocused(focused: boolean): void;
  onReply(listener: (bytes: Uint8Array) => void): () => void;
  view(): PaneChild;
  release(): void;
}

export type TerminalSurfaceFactory = (size: TerminalSize) => TerminalSurface;

export const surfaceScrollbackLines = 5000;

export function embeddedTerminalSurfaces(context: RenderContext): TerminalSurfaceFactory {
  return (size) => new EmbeddedSurface(context, size);
}

export function keyEventOf(chord: Chord, sequence: string | undefined): KeyEvent {
  const bytes = sequence ?? "";
  return new KeyEvent({
    name: chord.name,
    ctrl: chord.ctrl,
    meta: chord.meta,
    shift: chord.shift,
    option: false,
    sequence: bytes,
    number: false,
    raw: bytes,
    eventType: "press",
    source: "raw",
  });
}

class EmbeddedSurface implements TerminalSurface {
  private readonly renderable: FrameSurvivingTerminal;
  private readonly replyListeners = new Set<(bytes: Uint8Array) => void>();

  constructor(context: RenderContext, size: TerminalSize) {
    this.renderable = new FrameSurvivingTerminal(context, {
      cols: size.cols,
      rows: size.rows,
      maxScrollback: surfaceScrollbackLines,
      selectable: false,
      onData: (bytes) => {
        for (const listener of this.replyListeners) listener(bytes);
      },
    });
  }

  feed(bytes: Uint8Array): void {
    this.renderable.write(bytes);
  }

  encodeKey(chord: Chord, sequence: string | undefined): Uint8Array {
    return this.renderable.encodeKey(keyEventOf(chord, sequence));
  }

  encodePaste(text: string): Uint8Array {
    return this.renderable.encodePaste(new TextEncoder().encode(text));
  }

  resize(size: TerminalSize): void {
    this.renderable.width = size.cols;
    this.renderable.height = size.rows;
  }

  setFocused(focused: boolean): void {
    if (this.renderable.shownFocused === focused) return;
    this.renderable.shownFocused = focused;
    this.renderable.requestRender();
  }

  onReply(listener: (bytes: Uint8Array) => void): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }

  view(): PaneChild {
    return this.renderable;
  }

  release(): void {
    this.replyListeners.clear();
    this.renderable.release();
  }
}

// keywork rebuilds the whole OpenTUI tree every paint and destroys the old one, while the
// emulator state behind this renderable is native and must outlive any single frame: a frame
// teardown only detaches it, and release() is the one real destroy.
class FrameSurvivingTerminal extends EmbeddedTerminalRenderable {
  shownFocused = false;

  override get focused(): boolean {
    return this.shownFocused;
  }

  override destroyRecursively(): void {
    this.parent?.remove(this);
  }

  protected override onRemove(): void {}

  release(): void {
    super.destroyRecursively();
  }
}
