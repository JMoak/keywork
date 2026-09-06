export function pluralize(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export function sessionsFact(count: number): string {
  return count === 0 ? "no sessions" : pluralize(count, "session");
}
