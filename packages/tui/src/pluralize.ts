export function pluralize(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

export function sessionsFact(count: number): string {
  return count === 0 ? "no sessions" : pluralize(count, "session");
}
