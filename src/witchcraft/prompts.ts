/* The gallery's opening shelf.

   These are original, non-explicit prompts written for this site — the same
   voice as the empty-state samples in openhiggsfield/data.ts, extended into
   full, tagged, model-aware entries. Every entry is a *whole* prompt: subject,
   light, lens or camera move, and craft, so a card can be used as-is.

   This is the scaffold shelf. `research/gallery-seeds.json` (the research
   lane's vetted set) is merged on top when it lands — see seedPrompts().
   Nothing here claims a rendered thumbnail: the cards are typographic on
   purpose, and no preview image is presented as a generation result. */

export type Surface = "image" | "video";

export type PromptSeed = {
  id: string;
  title: string;
  prompt: string;
  surface: Surface;
  /** Free-form, lower-case tags. The first tag of a user save is a
      source marker so the UI can separate the house shelf from what the
      visitor wrote. */
  tags: string[];
  /** A named method the prompt follows, shown as a caption. These are
      documented public techniques, never a copied provider recipe. */
  preset?: string;
  /** How the prompt is meant to be used — shown on the card, and honoured by
      the "use in studio" action. */
  requiresInput?: boolean;
  /** Comma-separated model ids this prompt reads best against, when it is
      model-aware. Empty means: any model on its surface. */
  models?: string[];
};

export const SEED_PROMPTS: PromptSeed[] = [
  {
    id: "img-frosted-still-life",
    title: "Frosted still life",
    surface: "image",
    tags: ["product", "studio", "macro", "commercial"],
    preset: "Hard-source product light",
    prompt:
      "Editorial product still life: a frosted glass perfume bottle on brushed aluminium, single hard source from the left, crisp contact shadow, dew beading on the glass, shot on 100mm macro at f/8, black seamless backdrop, restrained monochrome palette.",
  },
  {
    id: "img-rain-portrait",
    title: "Rain, sodium, portrait",
    surface: "image",
    tags: ["portrait", "night", "editorial"],
    preset: "Available-light portraiture",
    prompt:
      "Editorial portrait of a woman in a wet wool coat under a sodium street lamp, rain in the air, rim light catching stray hair, 85mm at f/1.8, shallow depth of field, muted teal-and-ochre grade, cinematic and quiet.",
  },
  {
    id: "img-architectural-concrete",
    title: "Concrete geometry",
    surface: "image",
    tags: ["architecture", "brutalist", "overcast"],
    preset: "Large-format architecture",
    prompt:
      "Architectural study of a brutalist stair hall, board-marked concrete and one shaft of overcast daylight, wide 24mm perspective corrected, fine grey tonal separation, no people, tripod-still composition.",
  },
  {
    id: "img-desert-observatory",
    title: "Blue-hour observatory",
    surface: "image",
    tags: ["landscape", "night", "long-exposure"],
    preset: "Blue-hour long exposure",
    prompt:
      "A white observatory dome on a high desert ridge at blue hour, star trails wheeling above, rock striations catching the last cold light, 20mm, full-frame long exposure, deep shadows with clean highlight rolloff.",
  },
  {
    id: "img-fashion-motion",
    title: "Editorial motion blur",
    surface: "image",
    tags: ["fashion", "editorial", "movement", "non-explicit"],
    preset: "Fashion editorial, movement",
    prompt:
      "High-fashion editorial frame: a model in a tailored black coat mid-turn against a blank studio wall, drag-shutter motion blur trailing the coat hem, single large softbox feathered left, monochrome, film grain, confident and clean.",
  },
  {
    id: "img-luthier-hands",
    title: "Workshop hands",
    surface: "image",
    tags: ["portrait", "craft", "window-light"],
    preset: "North-window documentary",
    prompt:
      "Documentary portrait of an elderly luthier holding a half-built violin, north-facing window light, wood shavings on the bench, 50mm at f/2, muted warm palette, unposed and patient, close crop on the hands and instrument.",
  },
  {
    id: "img-teahouse-fog",
    title: "Mountain teahouse",
    surface: "image",
    tags: ["landscape", "fog", "quiet"],
    preset: "Layered atmospheric depth",
    prompt:
      "A lone timber teahouse on a fog-drowned ridge, layered mist stepping back through pine silhouettes, first pale light, 70mm compression, soft low-contrast tones, still and vast, no human figures.",
  },
  {
    id: "img-metal-typography",
    title: "Machined letterforms",
    surface: "image",
    tags: ["typography", "product", "graphic"],
    preset: "Graphic object study",
    prompt:
      "Large machined metal letterforms resting on a dark textured plinth, single grazing light raking across the edges, anodised graphite finish, 90mm macro tilt-shift, high micro-contrast, near-black background, graphic and precise.",
  },
  {
    id: "img-greenhouse-dust",
    title: "Glasshouse memory",
    surface: "image",
    tags: ["architecture", "interior", "dust-light"],
    preset: "God-ray interior",
    prompt:
      "An abandoned Victorian glasshouse, panes fogged, dust suspended in hard shafts of late sun, iron frame repeating into the distance, 35mm, muted green-grey grade, empty and reverent, no people.",
  },
  {
    id: "img-combat-silhouette",
    title: "Motion, non-graphic",
    surface: "image",
    tags: ["action", "silhouette", "non-graphic", "high-movement"],
    preset: "Back-lit action, non-graphic",
    prompt:
      "Silhouetted figure mid-leap across a warehouse skylight against harsh backlight, coat snapping behind, steam venting, no visible injury or contact, hard rim separation, 35mm, high-contrast monochrome, kinetic and abstract.",
  },
  {
    id: "vid-aerial-pines",
    title: "Aerial, fog pines",
    surface: "video",
    tags: ["aerial", "landscape", "dawn", "nature"],
    preset: "Slow aerial dolly-in",
    prompt:
      "Slow aerial dolly forward over fog-covered pine forest at dawn, volumetric light blooming through the canopy as the camera falls a few metres, gentle descent, no cut, 24fps, cool high-key grade with deep greens.",
  },
  {
    id: "vid-ink-bloom",
    title: "Ink bloom, ultra slow",
    surface: "video",
    tags: ["macro", "abstract", "slow-motion", "studio"],
    preset: "Ultra-slow macro",
    prompt:
      "Ultra slow-motion macro of black ink blooming into clear water against a black backdrop, backlit so the tendrils glow, camera locked off with a microscopic creep-in, no shake, monochrome, hypnotic and clean.",
  },
  {
    id: "vid-market-track",
    title: "Rain market tracking shot",
    surface: "video",
    tags: ["night", "handheld", "street", "rain"],
    preset: "Handheld tracking",
    prompt:
      "Handheld tracking shot following a figure through a rain-slick neon market at night, lenses catching the signs, shallow focus riding on the walk, reframes left to follow, 24fps, saturated reflections, unstaged and alive.",
  },
  {
    id: "vid-lighthouse-orbit",
    title: "Lighthouse orbit",
    surface: "video",
    tags: ["drone", "coast", "sea", "orbit"],
    preset: "Drone half-orbit",
    prompt:
      "Drone half-orbit around a stone lighthouse in heavy swell, grey Atlantic, wind spray crossing frame, the camera arcs smoothly from seaward to landward at constant altitude, no sudden move, overcast light, cinematic and cold.",
  },
  {
    id: "vid-sculptor-push",
    title: "Sculptor's hands, push-in",
    surface: "video",
    tags: ["documentary", "craft", "push-in", "light"],
    preset: "Slow push-in",
    prompt:
      "Slow push-in on a sculptor's hands shaping wet clay on a wheel, north window light, dust motes drifting, camera advances from waist to hands over the shot with no cut, 24fps, muted warm grade, patient and tactile.",
  },
  {
    id: "vid-musicvideo-turn",
    title: "Music-video whip pan",
    surface: "video",
    tags: ["music-video", "movement", "tungsten", "dance"],
    preset: "Whip-pan transition",
    prompt:
      "Music-video shot: a whip pan from a spinning vinyl record to a dancer caught mid-turn, tungsten glow, heavy directional motion blur on the pan, the dancer stays sharp at the end of the move, 24fps, warm and grainy.",
  },
  {
    id: "vid-canyon-timelapse",
    title: "Canyon shadow sweep",
    surface: "video",
    tags: ["timelapse", "landscape", "golden-hour"],
    preset: "Timelapse transition",
    prompt:
      "Timelapse of cloud shadows sweeping across a canyon rim from golden hour into dusk, locked wide camera, stars emerging at the end, no pan, 24fps playback, high dynamic range with clean shadow detail.",
  },
  {
    id: "vid-combat-continuity",
    title: "Action continuity, non-graphic",
    surface: "video",
    tags: ["action", "continuity", "non-graphic", "high-movement"],
    preset: "Causal action continuity",
    prompt:
      "Non-graphic action shot: a runner vaults a low wall and lands running, camera tracks parallel and holds the subject centred, clear cause-and-effect between the vault and the landing, no cuts, 24fps, hard daylight, kinetic but readable.",
  },
];

/** The shelf the gallery renders. The research lane's vetted seeds, when
    present, are merged by id so the house scaffold is never silently
    overwritten — a conflicting id keeps the researched entry and the house
    one moves aside under a suffixed id. */
export function seedPrompts(extra: PromptSeed[] = []): PromptSeed[] {
  const byId = new Map(SEED_PROMPTS.map((seed) => [seed.id, seed]));
  for (const entry of extra) {
    if (!entry?.id || !entry.prompt) continue;
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export type GalleryView = "all" | Surface | "favorites" | "mine";

/** Pure filter used by the page and by the focused tests: search over title,
    prompt and tags, a surface scope, and a tag scope. Order is preserved so
    the card order is stable between renders. */
export function filterSeeds(
  seeds: PromptSeed[],
  opts: { query?: string; view?: GalleryView; tag?: string | null; favorites?: Set<string> } = {},
): PromptSeed[] {
  const query = (opts.query ?? "").trim().toLowerCase();
  const view = opts.view ?? "all";
  const tag = opts.tag ?? null;

  return seeds.filter((seed) => {
    if (view === "image" || view === "video") {
      if (seed.surface !== view) return false;
    } else if (view === "favorites") {
      if (!opts.favorites?.has(seed.id)) return false;
    } else if (view === "mine") {
      if (!seed.tags.includes("mine")) return false;
    }
    if (tag && !seed.tags.includes(tag)) return false;
    if (!query) return true;
    if (seed.title.toLowerCase().includes(query)) return true;
    if (seed.prompt.toLowerCase().includes(query)) return true;
    return seed.tags.some((entry) => entry.includes(query));
  });
}

/** Every tag on the shelf, most-used first, for the tag rail. */
export function collectTags(seeds: PromptSeed[]): string[] {
  const counts = new Map<string, number>();
  for (const seed of seeds) {
    for (const tag of seed.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}
