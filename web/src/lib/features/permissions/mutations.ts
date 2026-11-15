import type { QueryClient } from "@tanstack/svelte-query";
import { addRule, removeRule, type RuleEdit } from "./api";

// A change in a file changes the rules of the user, of every session of the instance, and what a session still shows as blocked.
const invalidate = (client: QueryClient, host: string, instance: string, session: string | undefined) =>
  Promise.all([
    client.invalidateQueries({ queryKey: ["permissions", host, instance] }),
    client.invalidateQueries({ queryKey: ["session-permissions", host, instance, ...(session === undefined ? [] : [session])] }),
    client.invalidateQueries({ queryKey: ["session-blocked", host, instance, ...(session === undefined ? [] : [session])] }),
  ]);

export const addRuleMutation = (host: string, instance: string, session: string | undefined, client: QueryClient) => ({
  mutationKey: ["permissions", host, instance, "add-rule"] as const,
  mutationFn: (e: RuleEdit) => addRule(host, instance, session, e),
  onSettled: () => invalidate(client, host, instance, session),
});

export const removeRuleMutation = (host: string, instance: string, session: string | undefined, client: QueryClient) => ({
  mutationKey: ["permissions", host, instance, "remove-rule"] as const,
  mutationFn: (e: RuleEdit) => removeRule(host, instance, session, e),
  onSettled: () => invalidate(client, host, instance, session),
});
