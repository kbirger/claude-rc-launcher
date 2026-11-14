# Entity card implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One common card component for the screens that list things, such as instances and nodes. The card has slots for a title, a subtitle, and content such as pills. It also has a status slot at the top right. An action strip runs along the bottom, with an optional overflow menu.

**Architecture:** `EntityCard.svelte` builds on the shadcn `Card.Root` and takes Svelte 5 snippets. A small `Pill.svelte` replaces the hand-made chip class on the nodes screen. A shadcn `DropdownMenu` (Bits UI) gives the overflow menu. The instances screen and the nodes screen move onto the card and keep the same behavior.

**Tech Stack:** Svelte 5, Tailwind, shadcn-svelte, Bits UI, vitest.

**Spec:** There is no separate spec. The request is in the conversation of 2026-11-14. The user asked for a card with these slots: title, subtitle, content for pills, a top right slot for status indicators, and an action strip along the bottom. The strip has an optional overflow menu. The instances and nodes screens are the model. The user decided that the Stop button of an instance goes into the overflow menu. This work goes on the branch `feat/permissions` and into PR 9.

## Global Constraints

- Use Bits UI, shadcn-svelte, and Tailwind parts. Do not build a menu or a popover by hand.
- Mobile first. Every tap target is at least 44 px high, except the existing small ghost buttons of the action strip (32 px, as they are now).
- Behavior and text on the instances and nodes screens do not change, except that Stop moves into the overflow menu.
- The shared component lives in `web/src/lib/components/`. The folder `components/ui/` holds only generated shadcn parts.
- The web boundary test must still pass. The component imports nothing from a feature folder.
- Docs and plan text use short plain sentences with no semicolons, no em dashes, and no contractions.

## Review Focus

- A screen reader reads the card title as a heading. It reads the status with its label. The overflow button has a label that names the card.
- The overflow menu opens with the keyboard, closes with Escape, and returns focus to its button.
- A long name or a long path wraps and never pushes the status out of view at 390 px width.
- A card with no subtitle, no content, no actions, or no overflow draws no empty gaps.
- A disabled action or a disabled overflow item (a pending instance) cannot be used.

---

### Task 1: The card, the pill, and the menu

**Files:**
- Create: `web/src/lib/components/ui/dropdown-menu/` (generated with the shadcn-svelte CLI, see the existing parts for the style and `components.json` for the config)
- Create: `web/src/lib/components/EntityCard.svelte`, `web/src/lib/components/Pill.svelte`
- Test: `web/src/lib/components/EntityCard.test.ts`, with a helper component `EntityCardHarness.svelte` next to it (follow `RuleSheetHarness.svelte`)

**Interfaces:**
- Produces `Pill.svelte`: props `tone?: "default" | "primary"` and `class?`, plus `children`. Same look as the chip of `NodeList.svelte` (`chip` constant), and the primary tone is the hub chip look.
- Produces `EntityCard.svelte` props. These are `title: Snippet`, `subtitle?: Snippet`, `status?: Snippet`, `children?: Snippet` (the content), `actions?: Snippet` (the left group), and `actionsEnd?: Snippet` (the right group). The others are `overflow?: OverflowItem[]`, `overflowLabel?: string` (the label of the menu button, default "More actions"), `selected?: boolean`, `pending?: "starting" | string | false`, `class?: string`, and `size?: "default" | "sm"`.
- `type OverflowItem = { label: string; icon?: Component; onselect: () => void; destructive?: boolean; disabled?: boolean }`, exported from `EntityCard.svelte` in a `module` script.
- Layout, first part: a header row has the title at the left and the status slot at the right, aligned to the top. The title is an `h3` with `min-w-0` and `[overflow-wrap:anywhere]`.
- Layout, second part: under the header come the subtitle (muted, small), then the content (a wrap row for pills), then the action strip.
- The strip is a flex row. The `actions` group sits on the left. The `actionsEnd` group and the overflow button sit on the right. If none of the three exists, the strip does not draw. It keeps the `-mx-2` trick of the current cards, so the first and last ghost buttons line up with the text edges.
- The overflow button is a ghost icon button with the tabler `dots` icon (see the other icon imports). Its `aria-label` comes from `overflowLabel`. It opens a `DropdownMenu` with one item for each entry.
- A destructive item has the destructive text style. A disabled item is disabled. If `overflow` is empty or missing, no menu button draws.
- `selected` gives the primary border. `pending` dims the card, and `"starting"` gives the dashed border (these are the current instance card classes).

- [ ] **Step 1: Add the dropdown menu part.** Run the shadcn-svelte CLI to add `dropdown-menu` (`bunx shadcn-svelte@latest add dropdown-menu`, from `web/`, with the repo config). Check that the generated files follow the style of the other parts and that `bun run check` still gives 0 errors.
- [ ] **Step 2: Write the failing tests** in `EntityCard.test.ts`, using the helper component for snippet slots. Tests: `renders the title as a heading`, `renders subtitle, status, content, and actions in their slots`, `draws no action strip without actions, actionsEnd, or overflow`, `draws no overflow button without items`, `the overflow button has the label and opens a menu with the items`, `choosing an item calls onselect`, `a disabled item does not call onselect`, `Escape closes the menu`, `selected adds the primary border class and pending adds the dim class`.
- [ ] **Step 3: Run the tests and see them fail.** Run: `cd web && bunx --bun vitest run src/lib/components/EntityCard.test.ts`. Expected: FAIL, the component does not exist.
- [ ] **Step 4: Implement `Pill.svelte` and `EntityCard.svelte`** as described.
- [ ] **Step 5: Run the tests, the full suite, and the check.** Run: `cd web && bunx --bun vitest run && bun run check`. Expected: PASS and 0 errors.
- [ ] **Step 6: Commit.**

```bash
git add web/src/lib/components
git commit -m "feat(web): entity card, pill, and dropdown menu"
```

### Task 2: Instances use the card

**Files:**
- Modify: `web/src/lib/features/instances/InstanceList.svelte`
- Test: the existing instance tests. First look for a component test. If none exists, add a new `InstanceList.test.ts`.

**Interfaces:**
- Consumes `EntityCard`, `OverflowItem` (Task 1).
- Mapping: the title is the name. The status is the badge (the pending text or the state label with its tone classes, as now). The subtitle is the path in mono, then the user and uptime line. The left group of the strip holds Logs (with the chevron), Sessions, and Permissions. The right group holds Pause or Resume as the icon button. The overflow menu holds one item, Stop (destructive, with the stop icon). Its `overflowLabel` is `More actions for <name>`. The Stop item keeps the same `confirm` dialog and the same pending disabled rule. When the Logs panel is open, it stays an extra content block under the card. `pending` maps to the card `pending` prop.

- [ ] **Step 1: Write or update the failing tests.** `the card shows the name, state, path, and user with uptime`, `Pause and Resume stay in the strip`, `Stop is not in the strip but in the overflow menu`, `choosing Stop asks to confirm and calls the model stop only after yes`, `a pending instance has the overflow disabled`, `Logs opens the log panel`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd web && bunx --bun vitest run src/lib/features/instances`. Expected: FAIL on the Stop and overflow tests.
- [ ] **Step 3: Rewrite the markup of `InstanceList.svelte`** on `EntityCard`. Keep the model, the uptime function, and the logs toggle as they are. The text of every label stays the same.
- [ ] **Step 4: Run the full suite and the check.** Expected: PASS and 0 errors.
- [ ] **Step 5: Commit.**

```bash
git add web/src/lib/features/instances
git commit -m "refactor(web): instances use the entity card, Stop moves to the overflow menu"
```

### Task 3: Nodes use the card

**Files:**
- Modify: `web/src/lib/features/hosts/NodeList.svelte`
- Test: the existing node tests (look for `NodeList` tests), plus new ones as needed

**Interfaces:**
- Consumes `EntityCard`, `Pill` (Task 1).
- Mapping: title is the name, or the rename form while editing. Status is the health dot (keep its `role="img"` and label). The role chip and the component chips become `Pill`s in the content slot (the hub chip uses the primary tone). The action strip left group holds Rename, or Cancel while editing. The right group holds Update, and the Use or Active button, or Save while editing. The error texts and the node error text stay in the content area. `selected` maps to the card `selected` prop. There is no overflow menu for nodes.

- [ ] **Step 1: Write or update the failing tests.** `the card shows name, role, and component pills`, `the selected node has the selected style`, `Rename switches the title to the form and the strip to Cancel and Save`, `Update shows only for an outdated component`, `Use is disabled for a node that is not ok`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd web && bunx --bun vitest run src/lib/features/hosts`. Expected: FAIL for what the card changes.
- [ ] **Step 3: Rewrite the markup of `NodeList.svelte`** on `EntityCard` and `Pill`. Keep all functions (`edit`, `save`, `update`) and texts.
- [ ] **Step 4: Run the full suite and the check, then look at a screenshot.** Run the full suite and the check. Then take a 390 by 844 Playwright screenshot of the instances list and the nodes list with mocked data. Use a throwaway route and remove it after. Leave no dev server running. View the screenshot with the Read tool. Expected: no overflow, the status stays at the top right, and the strip lines up.
- [ ] **Step 5: Commit.**

```bash
git add web/src/lib/features/hosts
git commit -m "refactor(web): nodes use the entity card and pill"
```
