// Shared registry error identity across pack validation and composition.
export class GateRegistryError extends Error {
  constructor(message: string) { super(message); this.name = 'GateRegistryError'; }
}

