// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import EntityCardHarness from "./EntityCardHarness.svelte";

const open: Array<() => void> = [];
afterEach(() => {
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

function show(props: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(EntityCardHarness, { target, props: props as any });
  open.push(() => unmount(c));
  flushSync();
  return target;
}
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const menuButton = () => document.querySelector('button[aria-label="More actions"]') as HTMLButtonElement | null;
const strip = () => q('[data-slot="entity-card-actions"]');

// Bits UI opens the menu on pointerdown, or on a key press on the trigger.
function openMenu(label?: string) {
  const b = (label ? document.querySelector(`button[aria-label="${label}"]`) : menuButton()) as HTMLButtonElement;
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  flushSync();
}
const items = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
const click = (el: HTMLElement) => {
  el.click();
  flushSync();
};

test("renders the title as a heading", () => {
  show();
  expect(q("h3")?.textContent).toBe("Card name");
});

test("renders subtitle, status, content, and actions in their slots", () => {
  show({ slots: ["subtitle", "status", "content", "actions", "actionsEnd"] });
  expect(q('[data-testid="subtitle"]')?.textContent).toBe("Sub");
  expect(q('[data-testid="status"]')?.textContent).toBe("Running");
  expect(document.body.textContent).toContain("pill one");
  const s = strip()!;
  expect(s.contains(q('[data-testid="actions"]'))).toBe(true);
  expect(s.contains(q('[data-testid="actionsEnd"]'))).toBe(true);
  // The status shares the header row with the title.
  expect(q("h3")!.parentElement!.parentElement!.contains(q('[data-testid="status"]'))).toBe(true);
});

test("draws no action strip without actions, actionsEnd, or overflow", () => {
  show({ slots: ["subtitle"] });
  expect(strip()).toBeNull();
});

test("draws no overflow button without items", () => {
  show({ overflow: [] });
  expect(menuButton()).toBeNull();
  expect(strip()).toBeNull();
});

test("the overflow button has the label and opens a menu with the items", () => {
  show({ overflow: [{ label: "Rename", onselect() {} }, { label: "Delete", destructive: true, onselect() {} }], overflowLabel: "Node actions" });
  expect(menuButton()).toBeNull();
  const b = document.querySelector('button[aria-label="Node actions"]');
  expect(b).not.toBeNull();
  expect(items()).toHaveLength(0);
  openMenu("Node actions");
  expect(items().map((i) => i.textContent?.trim())).toEqual(["Rename", "Delete"]);
  expect(items()[1].getAttribute("data-variant")).toBe("destructive");
});

test("the overflow label defaults to More actions", () => {
  show({ overflow: [{ label: "Rename", onselect() {} }] });
  expect(menuButton()).not.toBeNull();
});

test("choosing an item calls onselect", () => {
  const onselect = vi.fn();
  show({ overflow: [{ label: "Rename", onselect }] });
  openMenu();
  click(items()[0]);
  expect(onselect).toHaveBeenCalledOnce();
});

test("a disabled item does not call onselect", () => {
  const onselect = vi.fn();
  show({ overflow: [{ label: "Rename", onselect, disabled: true }] });
  openMenu();
  expect(items()[0].hasAttribute("data-disabled")).toBe(true);
  click(items()[0]);
  expect(onselect).not.toHaveBeenCalled();
});

test("Escape closes the menu", async () => {
  show({ overflow: [{ label: "Rename", onselect() {} }] });
  openMenu();
  expect(items()).toHaveLength(1);
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => {
    flushSync();
    expect(items()).toHaveLength(0);
  });
});

test.each(["Enter", "ArrowDown"])("the menu opens with %s on the trigger", async (key) => {
  show({ overflow: [{ label: "Rename", onselect() {} }] });
  const b = menuButton()!;
  b.focus();
  b.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    flushSync();
    expect(items()).toHaveLength(1);
  });
});

test("after Escape the focus returns to the trigger", async () => {
  show({ overflow: [{ label: "Rename", onselect() {} }] });
  const b = menuButton()!;
  b.focus();
  b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(items()).toHaveLength(1));
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => {
    flushSync();
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(menuButton());
  });
});

test("the menu is not as narrow as the trigger", () => {
  show({ overflow: [{ label: "Rename", onselect() {} }] });
  openMenu();
  const c = q('[data-slot="dropdown-menu-content"]')!;
  expect(c.className).toContain("min-w-40");
  expect(c.className).toContain("w-auto");
  expect(c.className).not.toContain("w-(--bits-dropdown-menu-anchor-width)");
});

test("titleAside renders outside the heading", () => {
  show({ slots: ["titleAside"] });
  expect(q('[data-testid="aside"]')?.textContent).toBe("hub");
  expect(q("h3")!.textContent).not.toContain("hub");
  expect(q("h3")!.contains(q('[data-testid="aside"]'))).toBe(false);
});

test("titleEditor replaces the heading", () => {
  show({ slots: ["titleEditor"] });
  expect(q("h3")).toBeNull();
  expect(q('[data-testid="editor"]')).not.toBeNull();
});

test("a form inside titleEditor is not inside an h3", () => {
  show({ slots: ["titleEditor", "titleAside"] });
  expect(q('[data-testid="editor"]')!.closest("h3")).toBeNull();
  expect(q('[data-testid="aside"]')).not.toBeNull();
});

test("selected adds the primary border class and pending adds the dim class", () => {
  const cards = () => [...document.querySelectorAll('[data-slot="entity-card"]')] as HTMLElement[];
  show();
  show({ selected: true });
  show({ pending: "stopping" });
  show({ pending: "starting" });
  const [plain, sel, pend, starting] = cards();
  expect(plain.className).not.toContain("border-primary");
  expect(plain.className).not.toContain("opacity-60");
  expect(sel.className).toContain("border-primary");
  expect(pend.className).toContain("opacity-60");
  expect(pend.className).not.toContain("border-dashed");
  expect(starting.className).toContain("opacity-60");
  expect(starting.className).toContain("border-dashed");
});
