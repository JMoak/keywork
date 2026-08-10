import { isAbsolute, relative, resolve, sep } from "node:path";

export function confinedPath(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  const exit = relative(base, target);
  if (exit === ".." || exit.startsWith(`..${sep}`) || isAbsolute(exit)) {
    throw new Error(`${path} escapes the project root; tools may only touch files inside it`);
  }
  return target;
}
