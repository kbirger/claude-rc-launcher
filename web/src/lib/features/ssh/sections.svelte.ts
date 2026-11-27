/** The accordion sections of the SSH page, in page order. */
export const SECTIONS = ["requests", "targets", "nodes", "settings"] as const;
export type Section = (typeof SECTIONS)[number];

/** The sections that are open when the browser has no saved choice. */
export const DEFAULT_OPEN: Section[] = ["requests", "targets"];

/** The one localStorage key that holds the open sections. */
export const SECTIONS_KEY = "ssh-sections";

/** Something that needs the owner in a section. A new token opens the section again. */
export type Need = { section: Section; token: string };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const isSection = (value: unknown): value is Section => SECTIONS.includes(value as Section);

const inOrder = (sections: Iterable<Section>) => {
  const set = new Set(sections);
  return SECTIONS.filter((section) => set.has(section));
};

/** The saved open sections. A missing, broken or unreadable value gives the defaults. */
export function loadOpen(storage: Storage | undefined): Section[] {
  try {
    const saved = storage?.getItem(SECTIONS_KEY);
    if (saved == null) return [...DEFAULT_OPEN];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [...DEFAULT_OPEN];
    return inOrder(parsed.filter(isSection));
  } catch {
    return [...DEFAULT_OPEN];
  }
}

function save(storage: Storage | undefined, open: Section[]) {
  try {
    storage?.setItem(SECTIONS_KEY, JSON.stringify(open));
  } catch {
    // Storage is full or blocked: the choice lasts until the page closes.
  }
}

/** The browser localStorage, or nothing when the browser blocks it. */
export function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

// Which accordion sections of the SSH page are open. The owner's choice is saved in the browser. A need (a pending
// request, a link to a target) opens its section over that choice, but it is not saved. The owner can close a section
// that needs them. The same need does not open it again. Only a new token does.
//
// The needs are compared as one string, so a refetch that gives equal needs changes nothing. No effect is used: the
// open list is a writable derived that is worked out again only when the needs change.
export function createSectionsModel(opts: { storage: Storage | undefined; needs: () => Need[] }) {
  const { storage } = opts;
  // The owner's last choice. It is read only when the needs change, so it needs no rune.
  let chosen: Section[] = loadOpen(storage);
  const needKey = $derived(
    JSON.stringify(
      opts
        .needs()
        .filter((need) => need.token !== "")
        .map((need) => [need.section, need.token]),
    ),
  );
  let open = $derived.by(() => {
    const needed = (JSON.parse(needKey) as Array<[Section, string]>).map(([section]) => section);
    return inOrder([...chosen, ...needed]);
  });

  return {
    /** The open sections, in page order. */
    get open() {
      return open;
    },
    /**
     * Called by the accordion when the owner opens or closes a section. Only the sections that changed go into the saved
     * choice, so that a section that a need opened is not saved as open.
     */
    setOpen(value: string[]) {
      const next = inOrder(value.filter(isSection));
      const opened = next.filter((section) => !open.includes(section));
      const closed = open.filter((section) => !next.includes(section));
      open = next;
      chosen = inOrder([...chosen, ...opened].filter((section) => !closed.includes(section)));
      save(storage, chosen);
    },
  };
}
