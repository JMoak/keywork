export interface AuditEntry {
  timestamp: string;
  event: string;
}

export function auditLine(timestamp: string, event: string): string {
  return `- ${timestamp} ${event}\n`;
}

export function parseAuditLog(raw: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    const match = auditLinePattern.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined)
      entries.push({ timestamp: match[1], event: match[2] });
  }
  return entries;
}

const auditLinePattern = /^- (\S+) (.*)$/;
