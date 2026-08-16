// Structural mirror of @opentui/core@0.5.1 captureSpans() output (types.d.ts CapturedFrame);
// color components are 0..1 unit floats and attribute bits match TextAttributes.

export interface FrameColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface FrameSpan {
  readonly text: string;
  readonly fg: FrameColor;
  readonly bg: FrameColor;
  readonly attributes: number;
  readonly width: number;
}

export interface FrameLine {
  readonly spans: readonly FrameSpan[];
}

export interface CapturedFrame {
  readonly cols: number;
  readonly rows: number;
  readonly lines: readonly FrameLine[];
}

export const FrameAttributes = {
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
} as const;
