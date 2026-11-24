// The public face of the SSH feature: the page, and the two queries that the menu reads. Everything else stays inside
// the folder.
export { grantsQuery, statusQuery } from "./queries";
export { default as SshPage } from "./SshPage.svelte";
