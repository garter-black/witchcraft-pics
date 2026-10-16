/* The prompt gallery's own storage: favourites survive a reload, and every
   read/write is wrapped so a browser that refuses localStorage (private mode,
   disabled storage) degrades to an in-memory list with a visible notice rather
   than throwing into the render. */

const FAVORITES_KEY = "witchcraft.gallery.favorites.v1";
const MINE_KEY = "witchcraft.gallery.mine.v1";

export type SavedPrompt = {
  id: string;
  title: string;
  prompt: string;
  surface: "image" | "video";
  tags: string[];
};

function readJson<T>(key: string, fallback: T): { value: T; ok: boolean } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { value: fallback, ok: true };
    return { value: JSON.parse(raw) as T, ok: true };
  } catch {
    return { value: fallback, ok: false };
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Favourites are a set of seed id strings. Anything else in storage — an old
    schema, a corrupted value — is dropped rather than trusted. */
export function loadFavorites(): { ids: Set<string>; ok: boolean } {
  const { value, ok } = readJson<unknown>(FAVORITES_KEY, []);
  const list = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  return { ids: new Set(list), ok };
}

export function saveFavorites(ids: Set<string>): boolean {
  return writeJson(FAVORITES_KEY, [...ids]);
}

function isSavedPrompt(value: unknown): value is SavedPrompt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SavedPrompt>;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.prompt === "string" &&
    (item.surface === "image" || item.surface === "video") &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === "string")
  );
}

export function loadMine(): { items: SavedPrompt[]; ok: boolean } {
  const { value, ok } = readJson<unknown>(MINE_KEY, []);
  const items = Array.isArray(value) ? value.filter(isSavedPrompt) : [];
  return { items, ok };
}

export function saveMine(items: SavedPrompt[]): boolean {
  return writeJson(MINE_KEY, items);
}
