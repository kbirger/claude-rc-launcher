import { setup, type UnlockMethod } from "./api";
import { SSH_KEY } from "./queries";

// The recovery code is in the answer of the setup call, and only there. `gcTime: 0` drops the mutation from the cache
// as soon as nothing watches it. The caller reads the code from the return value of `mutateAsync`, resets the
// mutation at once and never reads `mutation.data`. Nothing here refetches the status: the form does that after the
// owner has typed back a part of the code, because a page that shows the status would otherwise drop the form.
export const setupMutation = () => ({
  mutationKey: [...SSH_KEY, "setup"] as const,
  mutationFn: (body: { method: UnlockMethod; credentialId?: string }) => setup(body),
  gcTime: 0,
});
