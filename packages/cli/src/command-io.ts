export type Confirm = (question: string) => Promise<boolean>;

export interface CommandIo {
  print?: (line: string) => void;
  printError?: (line: string) => void;
}

export interface ResolvedCommandIo {
  print: (line: string) => void;
  printError: (line: string) => void;
}

export function resolveCommandIo(io: CommandIo = {}): ResolvedCommandIo {
  return { print: io.print ?? console.log, printError: io.printError ?? console.error };
}
