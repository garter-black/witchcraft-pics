/* The /prompts gallery. Cards are typographic by design — no image here is a
   claimed generation result. Search covers title, prompt and tags; the views
   are all / image / video / favourites; copy and "use in studio" carry the
   exact prompt text, and "use in studio" never starts a run. */

import { useEffect, useMemo, useState } from "react";
import { getModel } from "@/generation/catalog";
import { openStudio } from "./route";
import { SEED_PROMPTS, collectTags, filterSeeds } from "./prompts";
import type { GalleryView, PromptSeed } from "./prompts";
import { loadFavorites, saveFavorites } from "./gallery-storage";

const VIEWS: { id: GalleryView; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Video" },
  { id: "favorites", label: "Favourites" },
];

/** The model to carry a prompt to when the studio is opened from here: the
    first configured model the seed names, else a sane default on the surface. */
function modelFor(seed: PromptSeed): string {
  for (const id of seed.models ?? []) {
    try {
      const m = getModel(id);
      if (m.surface === seed.surface) return m.id;
    } catch {
      /* a named model that no longer exists is skipped, not fatal */
    }
  }
  return seed.surface === "image" ? "rp-wan26-image" : "rp-wan26-video";
}

let storageBlocked = false;

export function PromptGallery() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<GalleryView>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    const { ids, ok } = loadFavorites();
    if (!ok) storageBlocked = true;
    return ids;
  });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(() =>
    storageBlocked ? { text: "Saved favourites could not be read on this device.", ok: false } : null,
  );

  const seeds = SEED_PROMPTS;
  const tags = useMemo(() => collectTags(seeds), [seeds]);
  const shown = useMemo(
    () => filterSeeds(seeds, { query, view, tag, favorites }),
    [seeds, query, view, tag, favorites],
  );

  /* A receipt clears itself so the card grid is never blocked by stale text. */
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  function toggleFavorite(id: string) {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavorites(next);
    const ok = saveFavorites(next);
    if (!ok) setNotice({ text: "Favourites could not be saved on this device.", ok: false });
  }

  async function copyPrompt(seed: PromptSeed) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(seed.prompt);
      setNotice({ text: `Copied “${seed.title}”.`, ok: true });
    } catch {
      setNotice({ text: "Clipboard unavailable — select the prompt text to copy it.", ok: false });
    }
  }

  function useInStudio(seed: PromptSeed) {
    const modelId = modelFor(seed);
    /* The handoff rides on history state, so it survives a storage-blocked
       browser and never silently drops the prompt. The shell consumes it on
       the home route, sets the model and the exact prompt, and shows the
       studio — even on the Video host. Nothing is generated here. */
    openStudio({ surface: seed.surface, model: modelId, text: seed.prompt });
  }

  return (
    <main className="wc-gallery" aria-label="Prompt gallery">
      <header className="wc-gallery-head">
        <div className="wc-gallery-eyebrow">THE PRACTICE / PROMPT LIBRARY</div>
        <h1>Prompts, ready to begin.</h1>
        <p className="wc-gallery-intro">
          {seeds.length} original example prompts for this site — subject, light and craft spelled out.
          Copy one, or carry it straight into the studio. These are starting points, not generated results.
        </p>
      </header>

      <div className="wc-gallery-controls" role="search">
        <label className="wc-gallery-search">
          <span className="wc-gallery-search-label">Search prompts</span>
          <input
            type="search"
            value={query}
            placeholder="Search title, prompt or tag…"
            aria-label="Search prompts by title, prompt or tag"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="wc-gallery-views" role="tablist" aria-label="Filter prompts">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={view === entry.id}
              className={view === entry.id ? "active" : ""}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="wc-gallery-tags" aria-label="Filter by tag">
        <button type="button" className={!tag ? "active" : ""} onClick={() => setTag(null)}>
          All tags
        </button>
        {tags.map((entry) => (
          <button
            key={entry}
            type="button"
            className={tag === entry ? "active" : ""}
            aria-pressed={tag === entry}
            onClick={() => setTag(tag === entry ? null : entry)}
          >
            {entry}
          </button>
        ))}
      </div>

      {notice && (
        <p className="wc-gallery-notice" role="status" data-ok={notice.ok}>
          {notice.text}
        </p>
      )}

      {shown.length === 0 ? (
        <p className="wc-gallery-empty" role="status">
          Nothing matches {query ? `“${query}”` : "this filter"} yet. Try another term or clear the filters.
        </p>
      ) : (
        <ul className="wc-gallery-grid">
          {shown.map((seed) => (
            <li key={seed.id} className="wc-card">
              <div className="wc-card-top">
                <span className="wc-card-surface">{seed.surface === "image" ? "IMAGE" : "VIDEO"}</span>
                <button
                  type="button"
                  className={"wc-card-fav" + (favorites.has(seed.id) ? " active" : "")}
                  aria-pressed={favorites.has(seed.id)}
                  aria-label={favorites.has(seed.id) ? `Remove ${seed.title} from favourites` : `Save ${seed.title} to favourites`}
                  onClick={() => toggleFavorite(seed.id)}
                >
                  {favorites.has(seed.id) ? "★" : "☆"}
                </button>
              </div>
              <h2 className="wc-card-title">{seed.title}</h2>
              <p className="wc-card-prompt">{seed.prompt}</p>
              {seed.preset && <p className="wc-card-preset">{seed.preset}</p>}
              {seed.requiresInput && (
                <p className="wc-card-requires" role="note">
                  Needs an input image — attach one in the studio before generating.
                </p>
              )}
              <div className="wc-card-tags">
                {seed.tags.slice(0, 4).map((entry) => (
                  <button key={entry} type="button" onClick={() => setTag(entry)}>
                    {entry}
                  </button>
                ))}
              </div>
              <div className="wc-card-actions">
                <button type="button" onClick={() => copyPrompt(seed)}>Copy prompt</button>
                <button type="button" className="wc-card-use" onClick={() => useInStudio(seed)}>
                  Use in studio
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
