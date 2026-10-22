export const contractVersion = "1.4";

export function contractMajorOf(contract: string): number {
  return Number.parseInt(contract.split(".")[0] ?? "", 10);
}
