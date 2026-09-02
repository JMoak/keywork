export function toUnixEol(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function countOccurrences(content: string, search: string): number {
  let count = 0;
  for (
    let at = content.indexOf(search);
    at !== -1;
    at = content.indexOf(search, at + search.length)
  ) {
    count += 1;
  }
  return count;
}
