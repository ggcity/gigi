#!/usr/bin/env node
/**
 * Regenerate the PWA / favicon icon set from a single source SVG.
 *
 * Run it whenever the icon artwork changes:
 *
 *     npm run gen:icons                       # uses assets/gigi-icon.svg → public/
 *     node scripts/gen-icons.mjs --source path/to/logo.svg
 *     node scripts/gen-icons.mjs --bg "#0b5cab" --maskable-scale 0.78
 *     node scripts/gen-icons.mjs --bg transparent   # keep the SVG's own alpha
 *
 * Outputs (referenced by index.html + public/manifest.webmanifest):
 *   public/favicon.svg                  (a copy of the source — scalable)
 *   public/favicon-32.png, -16.png      (raster fallback)
 *   public/icons/icon-192.png, -512.png            (manifest, purpose "any")
 *   public/icons/icon-192-maskable.png, -512-maskable.png  (purpose "maskable",
 *       artwork inset into the ~80% safe zone on a solid --bg field)
 *   public/icons/apple-touch-icon-180.png          (iOS home screen)
 *
 * The only dependency is `sharp` (a devDependency). If it is missing, this prints how
 * to install it and exits non-zero rather than throwing a stack trace.
 *
 * Notes
 *   - "any" icons and the favicons are rendered straight from the SVG (which already
 *     carries its own background), so swapping the SVG is WYSIWYG.
 *   - "maskable" icons need padding because launchers crop to a circle/squircle, so the
 *     artwork is scaled to --maskable-scale and centered on a solid --bg canvas.
 *   - Source SVGs are rasterized at high density for crisp large sizes.
 */
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── args ────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SOURCE = resolve(ROOT, arg('source', 'assets/gigi-icon.svg'));
const PUBLIC = resolve(ROOT, arg('out', 'public'));
const ICONS = resolve(PUBLIC, 'icons');
const BG_RAW = arg('bg', '#0b5cab');
const MASKABLE_SCALE = Number(arg('maskable-scale', '0.8'));
const BG_TRANSPARENT = /^(transparent|none)$/i.test(BG_RAW);
const BG = BG_TRANSPARENT ? { r: 0, g: 0, b: 0, alpha: 0 } : BG_RAW;

// ── load sharp (friendly failure) ────────────────────────────────────────────
let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error(
    '\n  gen-icons needs `sharp`. Install dev dependencies first:\n\n' +
      '      cd frontend-gigi && npm install\n\n' +
      '  (sharp is listed in devDependencies.)\n'
  );
  process.exit(1);
}

let svg;
try {
  svg = await readFile(SOURCE);
} catch {
  console.error(`\n  Source SVG not found: ${SOURCE}\n  Pass one with --source <path>.\n`);
  process.exit(1);
}

const DENSITY = 384; // rasterize the SVG crisply even at 512px
const rel = (p) => relative(ROOT, p);

/** Render the SVG to a square PNG, flattened onto --bg unless bg is transparent. */
async function flat(size, outPath) {
  let img = sharp(svg, { density: DENSITY }).resize(size, size, {
    fit: 'contain',
    background: BG,
  });
  if (!BG_TRANSPARENT) img = img.flatten({ background: BG });
  await img.png().toFile(outPath);
  console.log(`  ✓ ${rel(outPath)}  (${size}×${size})`);
}

/** Render a maskable icon: artwork inset to the safe zone, centered on a solid --bg. */
async function maskable(size, outPath) {
  const inner = Math.round(size * MASKABLE_SCALE);
  const art = await sharp(svg, { density: DENSITY }).resize(inner, inner, { fit: 'contain' }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toFile(outPath);
  console.log(`  ✓ ${rel(outPath)}  (${size}×${size}, maskable @ ${MASKABLE_SCALE})`);
}

await mkdir(ICONS, { recursive: true });

console.log(`\nGenerating icons from ${rel(SOURCE)}  (bg: ${BG_RAW})\n`);

// favicon: the vector original + raster fallbacks
await copyFile(SOURCE, resolve(PUBLIC, 'favicon.svg'));
console.log(`  ✓ ${rel(resolve(PUBLIC, 'favicon.svg'))}  (vector)`);
await flat(32, resolve(PUBLIC, 'favicon-32.png'));
await flat(16, resolve(PUBLIC, 'favicon-16.png'));

// manifest "any" + apple-touch
await flat(192, resolve(ICONS, 'icon-192.png'));
await flat(512, resolve(ICONS, 'icon-512.png'));
await flat(180, resolve(ICONS, 'apple-touch-icon-180.png'));

// manifest "maskable"
await maskable(192, resolve(ICONS, 'icon-192-maskable.png'));
await maskable(512, resolve(ICONS, 'icon-512-maskable.png'));

console.log('\nDone. Referenced by index.html and public/manifest.webmanifest.\n');
