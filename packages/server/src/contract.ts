export const contractVersion = "1.33";

export function contractMajorOf(contract: string): number {
  return Number.parseInt(contract.split(".")[0] ?? "", 10);
}
