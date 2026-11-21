import type { TrustStore } from "../src/trust";

export const allTrusted: TrustStore = {
  checker: () => Promise.resolve(() => true),
  add: async () => {},
};
