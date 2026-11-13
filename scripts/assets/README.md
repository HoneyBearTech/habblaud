# Habblaud assets (AI images + pixel art)

Habblaud's brand, UI illustrations and wall art. OpenRouter's image models draw
the images, which the Python post-processing turns into real pixel art: sharp grid,
limited palette, no dithering, binary alpha and upscaling only with NEAREST. Characters and furniture
are **not** here: they are procedural (`client/src/art`).

```
scripts/assets/
  specs.json            recipe for each asset: model, aspect ratio, prompt, styles and post-processing parameters
  generate.mjs          calls OpenRouter (Node 24, no dependencies), with cache, retries, budget and log
  postprocess.py        CLI: processes the raw images and composes brand, icons, frames, og-image and manifest
  pixelops.py           image operations (chroma key, grid detection, mode downscaling, palette...)
  pixelart.py           hand-drawn pixel art: 32/16 px mark, bitmap font and "Habblaud" sign
  test_pixelops.py      tests (stdlib unittest)
  generation-log.json   every request: model, exact prompt, file, cost and chosen takes
  .cache/               (ignored) raw/ = raw image in use, takes/ = all takes, contact-sheet.png
client/public/assets/   final output, served by Vite at /assets/ (manifest.json describes everything)
```

## Usage

Requirements: Node 24, the `OPENROUTER_KEY` variable exported (only for generating) and Python 3 with Pillow and
numpy (on this machine's macOS, `/usr/bin/python3` already has both in the user's site-packages).

```sh
node scripts/assets/generate.mjs models            # models with image output
node scripts/assets/generate.mjs list              # assets and cache state
node scripts/assets/generate.mjs gen               # generates what is missing in .cache/raw/
node scripts/assets/generate.mjs gen poster-cat --force                          # new take
node scripts/assets/generate.mjs gen logo-mark --model openai/gpt-5.4-image-2 --as gpt   # alternative take
node scripts/assets/generate.mjs pick logo-mark gpt                              # adopts the alternative take
python3 -E scripts/assets/postprocess.py           # generates client/public/assets/** + manifest + contact sheet
python3 -E scripts/assets/postprocess.py --only painting-cat --out /tmp/teste    # tests a single asset
python3 -E scripts/assets/test_pixelops.py         # tests (grid/de-upscaling, chroma key, mode, font, marks)
```

- `gen` uses up to 2 retries per asset, runs with `--concurrency` (default 3) and refuses to go over the
  budget (`--budget`, default 45 requests in the log). A lock (`.cache/generate.lock`) prevents
  two simultaneous runs, because one would rewrite the other's log.
- The post-processing is deterministic: run it as many times as you want, at no cost.
- The key only goes in the `Authorization` header: it is never printed, logged or written.
- `python3 -E` (and not `-I`): `-I` turns off the user's site-packages, where Pillow and numpy are.
  `-E` still ignores `PYTHONPATH`. The scripts are in `scripts/assets/` and the downloaded data
  in `.cache/` (another folder), so `sys.path` only contains our code.
- QA: open `scripts/assets/.cache/contact-sheet.png` (brand and wall art at 4x, illustration and og-image).

## Art direction (original prompts)

The prompts describe the style with generic words, without naming games, tilesets, artists or brands:
modern, bright and cozy office, cool neutral grays, light porcelain tile, honey-colored wood,
bluish glass, lit blue monitors, blue sofas with orange cushions, terracotta pots and colorful
folders, dark blue-gray outline (`#2b3245`) and light coming from the top left. The shared
`pixel` style (in `specs.json`) also asks for original art, without copying or imitating existing work.

The first takes of the logo and the illustration used an earlier version of this style, which cited
third-party commercial works as reference. They were discarded and left the log; the logo, the marks
drawn by hand from it, the icons, the og-image and the illustration were redone with the current
prompts. Paintings and posters never used that reference (their style is `wallart`/`poster`).

## Choosing the model

List from October 6, 2026: 11 models with `image` in `output_modalities`. I compared three strong models with the
same prompt ("mountains" painting) and, on the logo, Flash and Pro with the same prompt, judging the
result **after** the reduction to native size, which is what shows up in the game:

| Model | Raw | Reduced | Time | Cost/img |
|---|---|---|---|---|
| `google/gemini-3.1-flash-image` | flat, bold shapes, clean magenta; "pixels" of irregular size | **the most readable at 26x16 and 12x16** | ~10 s | ~US$ 0.07 |
| `google/gemini-3-pro-image` | rich, coherent pixel art, more regular grid | the best on the native logo and in scenes | ~25–35 s | ~US$ 0.14 |
| `openai/gpt-5.4-image-2` | the most detailed | too much detail: it turns into noise | 75–120 s | higher |

Decision:
- **Gemini 3.1 Flash Image** (default): paintings and posters. Large, flat shapes survive
  26x16 and 12x16; it is fast and cheap, which left budget to redo what came out weak.
- **Gemini 3 Pro Image**: logo and illustration of the empty office. On the logo, the Flash takes had
  "pixels" off the grid (the de-upscaling left noise in the windows); the Pro one comes out clean. In the
  illustration, it reproduces the elements of the game itself: light porcelain tile, white desks with
  blue monitors, blue sofa with orange cushions, water cooler, terracotta and colorful folders. With that,
  it is consistent with the world.

## Post-processing pipeline

1. **Chroma key**: the background color is the median of the image's border (the AI doesn't always hit
   `#FF00FF`), plus any clearly magenta tone (fringe). Small islands are removed.
2. **De-upscaling** (`kind: native`): the AI draws on a grid of "big pixels" (~10 px per pixel
   in a 1024 image). A periodicity detector (a comb over the color edges, on both axes,
   preferring the smallest divisor of the best period) finds the grid, and each block becomes one pixel (mode of
   the core). The result is the AI's native pixel art, lossless. That is how `logo-detailed.png` (78x86) is born.
3. **Mode downscaling** (`art`, `poster`, `scene`): crop to the aspect ratio and downscaling in which each cell
   gets the most frequent color of an intermediate palette, without mixing colors. This gives sharp
   edges, unlike averaging. `darkBias` favors dark tones (outlines) or, if negative,
   light ones (lit windows).
4. **Palette**: median cut + k-means, **no dithering**. The `balance` option resamples by 1/frequency^b,
   so that small-area colors (the green of the plants) don't vanish. With it, the scene fit in 32 colors.
   On the logo, `merge` fuses nearly equal tones (RGB distance smaller than the value) that k-means sometimes
   creates in the same flat area; one tone per material is left (24 colors).
5. **Finishing**: `despeckle` removes isolated pixels; 1px `#2b3245` outline on the posters;
   3px frames (wood, black, white, gold) with light on the top and left on the paintings.

### What was drawn by hand (and why)

- **32x32 mark and 16x16 favicon** (`pixelart.py`). The AI's native art is 78x86 px, and reducing it to 32
  or 16 always scrambles windows and bands. So the small mark is a "hinting" of the AI's drawing:
  same building (slab with a light edge, pot on the right, wood bands, two blue screens on the 2nd floor,
  glass door with awning), same sampled palette, redrawn pixel by pixel. The AI's version appears where there is
  room (`logo-detailed.png`, `icon-512.png`, og-image).
- **Sign and og-image texts**: AI text, once reduced, becomes unreadable, and Pixelify Sans at pixel
  sizes closes the opening of the "C" ("Oode Town"). That is why there is a custom proportional 5x7 bitmap
  font, with lowercase, descenders and Portuguese accents (á à â ã é ê í ó ô õ ú ç).

## Deliverables (`client/public/assets/`)

| File | Size | Note |
|---|---|---|
| `brand/logo-mark.png` / `@4x` | 32x32 / 128x128 | transparent, drawn by hand from the AI's |
| `brand/logo-detailed.png` | 78x86 | the AI's native art (transparent) |
| `brand/favicon-16.png`, `favicon-32.png` | 16, 32 | transparent |
| `brand/apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | 180, 192, 512 | dusk sky in bands + sidewalk; 512 uses the detailed building |
| `brand/signage.png` / `@4x` | 64x16 / 256x64 | reception sign |
| `illustrations/empty-office.png` | 960x540 | 480x270 native, x2 NEAREST, 32 colors |
| `art/painting-*.png` (8) | 26x16 | canvas only (no frame), for `rects.art` of the `painting` sprite |
| `art/painting-wide-*.png` (3) | 58x24 | lounge |
| `art/framed/painting-*.png` | 32x22 and 64x30 | same art with a 3px frame, taking up exactly 2 or 4 tiles |
| `art/poster-*.png` (6) | 12x16 | with outline; ids match the variants of the `poster` furniture |
| `og-image.png` | 1200x630 | 600x315 native x2 |

### manifest.json

```jsonc
{
  "version": 1,
  "brand": {
    "mark": { "file": "brand/logo-mark.png", "w": 32, "h": 32 },
    "markLarge": { "file": "brand/logo-mark@4x.png", "w": 128, "h": 128 },
    "markDetailed": { "file": "brand/logo-detailed.png", "w": 78, "h": 86 },   // extra
    "signage": { "file": "brand/signage.png", "w": 64, "h": 16 },
    "signageLarge": { "file": "brand/signage@4x.png", "w": 256, "h": 64 },    // extra
    "favicon16": "brand/favicon-16.png", "favicon32": "brand/favicon-32.png",
    "appleTouch": "brand/apple-touch-icon.png", "icon192": "brand/icon-192.png", "icon512": "brand/icon-512.png"
  },
  "illustrations": { "emptyOffice": { "file": "illustrations/empty-office.png", "w": 960, "h": 540, "scale": 2 } },
  "wallArt": [
    { "id": "painting-mountains", "kind": "painting", "file": "art/painting-mountains.png", "w": 26, "h": 16,
      "tiles": 2, "title": "Montanhas ao amanhecer", "framed": { "file": "art/framed/painting-mountains.png", "w": 32, "h": 22 } },
    { "id": "poster-coffee", "kind": "poster", "variant": "coffee", "file": "art/poster-coffee.png", "w": 12, "h": 16, "tiles": 1, "title": "Café" }
  ],
  "og": "og-image.png"
}
```

Paths relative to `/assets/`. `w`/`h` are the file's. `tiles` is the width of the wall gap in
tiles (poster 1, painting 2, wide painting 4), useful for choosing the right art for each frame. In the
illustration, `scale` indicates the NEAREST upscaling already applied (native = w/scale). `variant` of the posters
is the value of the variant of the `poster` furniture in `client/src/art/api.ts` (`ship_it` included).

## Budget and log

32 requests out of 45 in the log (25 Flash, 6 Pro, 1 GPT 5.4), no failures, ~US$ 2.58 reported by the
API. The log doesn't include the 10 discarded takes of the logo and the illustration (see "Art direction"); the
`n` numbers were renumbered in sequence. The detail is in `generation-log.json`. `picks` records
the takes adopted from comparisons (`logo-mark@v2e`, `empty-office@v2a`,
`painting-mountains@gemini31flash`). The entry of the Flash take of `painting-mountains` was
rebuilt (with no reported cost), because two parallel runs overwrote the log; that is
what motivated the lock. `specs.json` is the current recipe; the log keeps the exact prompt of each take (the
paintings generated before the "full bleed" reinforcement in the `wallart` style used the earlier version
of that text, and the takes `logo-mark@v2a` to `@v2c` used earlier versions of the logo prompt).
