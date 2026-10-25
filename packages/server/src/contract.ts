export const contractVersion = "1.7";

export function contractMajorOf(contract: string): number {
  return Number.parseInt(contract.split(".")[0] ?? "", 10);
}
