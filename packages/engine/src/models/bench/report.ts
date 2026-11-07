import type { ServerFingerprint } from "../capabilities/index.ts";
import type { BenchReport, ChatBenchReport, DecideBenchReport, Spread } from "./run.ts";

export function formatBenchReport(report: BenchReport): string {
  const lines = report.kind === "chat" ? chatLines(report) : decideLines(report);
  return `${lines.join("\n")}\n`;
}

function chatLines(report: ChatBenchReport): string[] {
  return [
    `bench ${report.reference} · trace ${report.trace} · ${report.repeats} repeats of ${report.turns} turns`,
    serverLine(report.fingerprint),
    row("valid@1", share(report.validAt1)),
    row("tool name", share(report.toolCalls.name)),
    row("tool schema", share(report.toolCalls.schema)),
    row("tool arguments", share(report.toolCalls.arguments)),
    row("no tool when none", share(report.toolCalls.noTool)),
    row("parallel calls", share(report.toolCalls.parallel)),
    row("tokens per turn", amount(report.tokensPerTurn, 0)),
    row("seconds per turn", amount(report.secondsPerTurn, 2)),
    row("decode tok/s", amount(report.decodeTokensPerSecond, 1)),
    row("fallbacks", String(report.fallbacks)),
  ];
}

function decideLines(report: DecideBenchReport): string[] {
  const fitted = report.thresholdAtPrecision;
  return [
    `bench ${report.reference} · decide · ${report.repeats} repeats of ${report.rows} labelled rows`,
    serverLine(report.fingerprint),
    row("valid@1", share(report.validAt1)),
    row("Brier", amount(report.brier, 3)),
    row("ECE (10 bins)", amount(report.ece, 3)),
    row("AUROC", amount(report.auroc, 3)),
    row(
      "threshold",
      fitted === null
        ? "n/a: no bar reaches the target with enough rows"
        : `${fitted.threshold.toFixed(2)} for precision ${fitted.precision.toFixed(2)} at target ${fitted.target.toFixed(2)}, coverage ${fitted.coverage.toFixed(2)} of ${fitted.n}`,
    ),
    row("seconds per question", amount(report.secondsPerQuestion, 3)),
    row("input tokens per question", amount(report.inputTokensPerQuestion, 0)),
    row("fallbacks", String(report.fallbacks)),
  ];
}

function serverLine(fingerprint: ServerFingerprint): string {
  const version = [fingerprint.version, fingerprint.build].filter((part) => part !== null);
  const described = version.length === 0 ? "version unknown" : version.join(" ");
  return `server ${fingerprint.kind} ${described} · fingerprint ${fingerprint.id}`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(26)}${value}`;
}

function share(spread: Spread | null): string {
  return amount(spread, 2);
}

function amount(spread: Spread | null, digits: number): string {
  if (spread === null) return "n/a";
  const mean = spread.mean.toFixed(digits);
  if (spread.min === spread.max) return mean;
  return `${mean} (${spread.min.toFixed(digits)} to ${spread.max.toFixed(digits)})`;
}
