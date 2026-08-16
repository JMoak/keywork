import {
  type CapturedFrame,
  FrameAttributes,
  type FrameColor,
  type FrameLine,
  type FrameSpan,
} from "./frame.ts";

export interface SvgOptions {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
}

export const defaultSvgOptions: Required<SvgOptions> = {
  fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
  fontSize: 14,
  cellWidth: 8.4,
  cellHeight: 17,
};

export function frameToSvg(frame: CapturedFrame, options: SvgOptions = {}): string {
  const metrics: Metrics = {
    fontFamily: options.fontFamily ?? defaultSvgOptions.fontFamily,
    fontSize: options.fontSize ?? defaultSvgOptions.fontSize,
    cellWidth: options.cellWidth ?? defaultSvgOptions.cellWidth,
    cellHeight: options.cellHeight ?? defaultSvgOptions.cellHeight,
  };
  const canvas = dominantBackground(frame);
  return [
    openingTag(frame, metrics),
    `<rect width="100%" height="100%" fill="${canvas}"/>`,
    ...frame.lines.flatMap((line, row) => backgroundRects(line, row, canvas, metrics)),
    ...frame.lines.flatMap((line, row) => rowText(line, row, metrics)),
    "</svg>",
  ].join("\n");
}

type Metrics = Required<SvgOptions>;

function openingTag(frame: CapturedFrame, metrics: Metrics): string {
  const width = px(frame.cols * metrics.cellWidth);
  const height = px(frame.rows * metrics.cellHeight);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"` +
    ` viewBox="0 0 ${width} ${height}" font-family="${escapeXml(metrics.fontFamily)}"` +
    ` font-size="${metrics.fontSize}" dominant-baseline="central" xml:space="preserve">`
  );
}

function dominantBackground(frame: CapturedFrame): string {
  const cellsByColor = new Map<string, number>();
  for (const line of frame.lines) {
    for (const span of line.spans) {
      const background = opaqueBackground(span);
      if (background) {
        cellsByColor.set(background, (cellsByColor.get(background) ?? 0) + span.width);
      }
    }
  }
  let winner = "#000000";
  let winningCells = 0;
  for (const [color, cells] of cellsByColor) {
    if (cells > winningCells) {
      winner = color;
      winningCells = cells;
    }
  }
  return winner;
}

function backgroundRects(line: FrameLine, row: number, canvas: string, metrics: Metrics): string[] {
  return coalesce(line, opaqueBackground, (a, b) => a === b).flatMap((segment) =>
    segment.style && segment.style !== canvas
      ? [
          `<rect x="${px(segment.column * metrics.cellWidth)}"` +
            ` y="${px(row * metrics.cellHeight)}"` +
            ` width="${px(segment.width * metrics.cellWidth)}"` +
            ` height="${px(metrics.cellHeight)}" fill="${segment.style}"/>`,
        ]
      : [],
  );
}

function rowText(line: FrameLine, row: number, metrics: Metrics): string[] {
  const runs = coalesce(line, textStyle, sameTextStyle)
    .filter((run) => run.text.trim() !== "" && run.style.fill !== "none")
    .map(trimEdgeSpaces);
  if (runs.length === 0) return [];
  const y = px((row + 0.5) * metrics.cellHeight);
  return [`<text y="${y}">${runs.map((run) => tspan(run, metrics)).join("")}</text>`];
}

interface TextStyle {
  readonly fill: string;
  readonly attributes: number;
}

interface Segment<Style> {
  column: number;
  width: number;
  text: string;
  style: Style;
}

function coalesce<Style>(
  line: FrameLine,
  styleOf: (span: FrameSpan) => Style,
  sameStyle: (a: Style, b: Style) => boolean,
): Segment<Style>[] {
  const segments: Segment<Style>[] = [];
  let column = 0;
  for (const span of line.spans) {
    if (span.width > 0) {
      const style = styleOf(span);
      const last = segments[segments.length - 1];
      if (last && sameStyle(last.style, style)) {
        last.text += span.text;
        last.width += span.width;
      } else {
        segments.push({ column, width: span.width, text: span.text, style });
      }
    }
    column += span.width;
  }
  return segments;
}

const textStyle = (span: FrameSpan): TextStyle => ({
  fill: span.fg.a > 0 ? cssColor(span.fg) : "none",
  attributes: span.attributes & supportedAttributes,
});

const sameTextStyle = (a: TextStyle, b: TextStyle): boolean =>
  a.fill === b.fill && a.attributes === b.attributes;

const opaqueBackground = (span: FrameSpan): string | undefined =>
  span.bg.a > 0 ? cssColor(span.bg) : undefined;

function trimEdgeSpaces(run: Segment<TextStyle>): Segment<TextStyle> {
  const leading = run.text.length - run.text.replace(/^ +/, "").length;
  const trailing = run.text.length - run.text.replace(/ +$/, "").length;
  return {
    ...run,
    column: run.column + leading,
    width: run.width - leading - trailing,
    text: run.text.slice(leading, run.text.length - trailing),
  };
}

function tspan(run: Segment<TextStyle>, metrics: Metrics): string {
  return (
    `<tspan x="${px(run.column * metrics.cellWidth)}"` +
    ` textLength="${px(run.width * metrics.cellWidth)}" lengthAdjust="spacingAndGlyphs"` +
    ` fill="${run.style.fill}"${attributeMarkup(run.style.attributes)}>` +
    `${escapeXml(run.text)}</tspan>`
  );
}

const supportedAttributes =
  FrameAttributes.BOLD | FrameAttributes.DIM | FrameAttributes.ITALIC | FrameAttributes.UNDERLINE;

function attributeMarkup(attributes: number): string {
  const parts: string[] = [];
  if (attributes & FrameAttributes.BOLD) parts.push('font-weight="bold"');
  if (attributes & FrameAttributes.ITALIC) parts.push('font-style="italic"');
  if (attributes & FrameAttributes.UNDERLINE) parts.push('text-decoration="underline"');
  if (attributes & FrameAttributes.DIM) parts.push('opacity="0.6"');
  return parts.map((part) => ` ${part}`).join("");
}

function cssColor(color: FrameColor): string {
  const r = channelByte(color.r);
  const g = channelByte(color.g);
  const b = channelByte(color.b);
  if (color.a >= 1) return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(color.a * 1000) / 1000})`;
}

const channelByte = (unit: number): number => Math.round(Math.min(1, Math.max(0, unit)) * 255);

const hexByte = (byte: number): string => byte.toString(16).padStart(2, "0");

const px = (value: number): string => String(Math.round(value * 100) / 100);

const xmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => xmlEntities[char] ?? char);
}
