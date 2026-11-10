export const contractVersion = "1.31";

export function contractMajorOf(contract: string): number {
  return Number.parseInt(contract.split(".")[0] ?? "", 10);
}
