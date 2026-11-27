import type { TrustStore } from "../../src/instances/trust";

export const allTrusted: TrustStore = {
  checker: () => Promise.resolve(() => true),
  add: async () => {},
};
