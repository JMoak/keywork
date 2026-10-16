export function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function dollars(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function grouped(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
