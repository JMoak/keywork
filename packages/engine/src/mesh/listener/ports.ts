export const defaultMeshPort = 47800;

export interface PortRange {
  first: number;
  last: number;
}

export const screenUdpPorts: PortRange = { first: 47810, last: 47829 };

export function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}
