import type { TrustStore } from "../src/trust";

export const allTrusted: TrustStore = {
  checker: async () => () => true,
  add: async () => {},
};
