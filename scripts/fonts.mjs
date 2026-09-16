#!/usr/bin/env node
// fonts.mjs
//
// Regenerates the self-hosted web fonts used by Invoisaurus.
//
// Fraunces and Alegreya Sans: each upstream TTF is subset to the Google Fonts
// "latin" range with harfbuzz (via the `subset-font` package) and written as
// woff2.
//
// IBM Plex Mono: not subset. Its license reserves the name "Plex", and under
// OFL section 3 a Modified Version (which a subset is) may not use a Reserved
// Font Name. The two output files are IBM's own prebuilt Latin-1 woff2 builds,
// extracted byte-for-byte from the pinned release zip and checked against a
// SHA-256 recorded below.
//
// Each family's upstream OFL.txt is written beside the fonts as
// OFL-<Family>.txt, byte-for-byte, because the license requires its text to
// travel with every copy of the font.
//
// Downloads are cached in node_modules/.cache/invoisaurus-fonts, which the
// repo's own `node_modules/` ignore rule already covers. A cached file is
// reused only if its SHA-256 still matches the pinned value. Everything is
// written to the directory given by --out (default: public/fonts).
//
// Usage:
//   node scripts/fonts.mjs --out public/fonts
//
// Dependencies (see package.json, both pinned to exact versions because the
// bytes of the subset output depend on the harfbuzz build inside them):
//   subset-font  - harfbuzz-wasm subsetter + woff2 encoder, also does
//                  variable-font axis instancing (pinning SOFT/WONK on
//                  Fraunces, clamping its wght range).
//   fflate       - pure-JS zip reader, used only to pull two woff2 files and
//                  the license out of the IBM Plex Mono release zip without
//                  shelling out to a system `unzip` binary.
//
// Run `npm install` once (repo root) before running the script.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import subsetFont from "subset-font";
import { unzipSync } from "fflate";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// node_modules/.cache is the conventional home for tool caches, and the repo's
// own `node_modules/` ignore rule already covers it, so the cache needs no
// ignore rule of its own and a fresh clone ignores it with no local setup.
const CACHE_DIR = path.join(SCRIPT_DIR, "..", "node_modules", ".cache", "invoisaurus-fonts");

// ---------------------------------------------------------------------------
// Upstream sources
//
// Every URL below points at a specific commit or release asset, never a
// branch HEAD or a "latest" alias, so a re-run next year fetches the exact
// same bytes. Every SHA-256 was computed from that exact download; a mismatch
// means the upstream URL now serves something else (a force-push, a re-tagged
// release, or a corrupted download) and the script refuses to use it rather
// than fail silently.
// ---------------------------------------------------------------------------

// undercasetype/Fraunces, master branch commit as of 2026-09-16. The
// variable-font TTF is pulled from this pinned commit rather than a tagged
// release.
const FRAUNCES_COMMIT = "7ccdec31c6028118dce3e47fe864e3744460371d";

// huertatipografica/Alegreya-Sans, master branch commit as of 2026-09-16. The
// static TTFs are pulled from this pinned commit rather than a tagged
// release.
const ALEGREYA_SANS_COMMIT = "b19cf06866bb153cc0ed3ea9d9131b180c48fee4";

// IBM/plex release `@ibm/plex-mono@2.5.0` (published 2026-06-11). This is a
// static-instances release, not the variable-font release, because the app
// uses two fixed weights (400 and 500).
const IBM_PLEX_MONO_ZIP_URL =
  "https://github.com/IBM/plex/releases/download/%40ibm/plex-mono%402.5.0/ibm-plex-mono.zip";

const SOURCES = {
  fraunces: {
    url: `https://raw.githubusercontent.com/undercasetype/Fraunces/${FRAUNCES_COMMIT}/fonts/variable/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf`,
    sha256: "0776a870a0856b296e11639505ac0cf9be5e7800bb1849dfa21a1bd182455fc0",
    cacheFile: "fraunces/Fraunces-VF.ttf",
  },
  "fraunces-license": {
    url: `https://raw.githubusercontent.com/undercasetype/Fraunces/${FRAUNCES_COMMIT}/OFL.txt`,
    sha256: "bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b",
    cacheFile: "fraunces/OFL.txt",
  },
  "alegreya-sans-regular": {
    url: `https://raw.githubusercontent.com/huertatipografica/Alegreya-Sans/${ALEGREYA_SANS_COMMIT}/fonts/ttf/AlegreyaSans-Regular.ttf`,
    sha256: "6786f1ec32180b3cd6dd241a52496316eff61f3d7136e25396819434e3891926",
    cacheFile: "alegreya-sans/AlegreyaSans-Regular.ttf",
  },
  "alegreya-sans-italic": {
    url: `https://raw.githubusercontent.com/huertatipografica/Alegreya-Sans/${ALEGREYA_SANS_COMMIT}/fonts/ttf/AlegreyaSans-Italic.ttf`,
    sha256: "55186df2e55f1f8731663c6ad338e8bf15ce0b6f6da67cc2b0ad260b00c8896f",
    cacheFile: "alegreya-sans/AlegreyaSans-Italic.ttf",
  },
  "alegreya-sans-medium": {
    url: `https://raw.githubusercontent.com/huertatipografica/Alegreya-Sans/${ALEGREYA_SANS_COMMIT}/fonts/ttf/AlegreyaSans-Medium.ttf`,
    sha256: "88d470fec04dd8a48dba3bc2b08b30b89bba432787146be333eec85022f8e2d9",
    cacheFile: "alegreya-sans/AlegreyaSans-Medium.ttf",
  },
  "alegreya-sans-bold": {
    url: `https://raw.githubusercontent.com/huertatipografica/Alegreya-Sans/${ALEGREYA_SANS_COMMIT}/fonts/ttf/AlegreyaSans-Bold.ttf`,
    sha256: "33283cbec2caaf0310086b6c12a792ff25331271d63b3e74c567a135e1af12b9",
    cacheFile: "alegreya-sans/AlegreyaSans-Bold.ttf",
  },
  "alegreya-sans-license": {
    url: `https://raw.githubusercontent.com/huertatipografica/Alegreya-Sans/${ALEGREYA_SANS_COMMIT}/OFL.txt`,
    sha256: "6222b580f51d93a72ea22ff97eec4b03279016545b5b2bebb2ea76519372eb85",
    cacheFile: "alegreya-sans/OFL.txt",
  },
  "ibm-plex-mono-zip": {
    url: IBM_PLEX_MONO_ZIP_URL,
    sha256: "6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c",
    cacheFile: "ibm-plex-mono/ibm-plex-mono.zip",
  },
};

// Files pulled out of the IBM Plex Mono zip. `zipPath` is the entry's path
// inside the archive; `sha256` verifies the extracted bytes independently of
// the zip's own hash, so a future fflate/zip-format change is also caught.
//
// The two woff2 members are IBM's own Latin-1 split builds. They are written
// to the output directory unchanged. The `unicode-range` that goes with them
// in public/css/app.css is copied from the IBMPlexMono-Regular.css and
// IBMPlexMono-Medium.css files beside them in the same zip
// (fonts/split/woff2/).
const IBM_PLEX_MONO_ZIP_MEMBERS = {
  "ibm-plex-mono-regular": {
    zipPath: "ibm-plex-mono/fonts/split/woff2/IBMPlexMono-Regular-Latin1.woff2",
    sha256: "e8993d946649b9d01abb1ed06d574b19d8ea3e66b5c3948602db335c44c18e56",
    cacheFile: "ibm-plex-mono/IBMPlexMono-Regular-Latin1.woff2",
  },
  "ibm-plex-mono-medium": {
    zipPath: "ibm-plex-mono/fonts/split/woff2/IBMPlexMono-Medium-Latin1.woff2",
    sha256: "41201b658a328b9d00368215c2f1102770f80b15952ab82631e4006255e6365d",
    cacheFile: "ibm-plex-mono/IBMPlexMono-Medium-Latin1.woff2",
  },
  "ibm-plex-mono-license": {
    zipPath: "ibm-plex-mono/LICENSE.txt",
    sha256: "7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da",
    cacheFile: "ibm-plex-mono/OFL.txt",
  },
};

// ---------------------------------------------------------------------------
// Subsetting parameters
// ---------------------------------------------------------------------------

// Google Fonts' standard "latin" unicode-range, spelled out as hex ranges so
// the same list drives both the harfbuzz subset (as literal characters) and
// the CSS `unicode-range` declaration (as `U+` tokens).
const LATIN_RANGES = [
  "0000-00FF",
  "0131",
  "0152-0153",
  "02BB-02BC",
  "02C6",
  "02DA",
  "02DC",
  "0304",
  "0308",
  "0329",
  "2000-206F",
  "20AC",
  "2122",
  "2191",
  "2193",
  "2212",
  "2215",
  "FEFF",
  "FFFD",
];

const UNICODE_RANGE_CSS = LATIN_RANGES.map((r) => `U+${r}`).join(", ");

// Expand the ranges above into the actual characters harfbuzz should keep.
// hb-subset (via subset-font) computes glyph closure from this text, so it
// does not matter that most of these code points never appear together in
// real invoice copy -- only that every glyph the range covers survives.
function buildSubsetText(ranges) {
  const codepoints = [];
  for (const range of ranges) {
    const [startHex, endHex] = range.split("-");
    const start = parseInt(startHex, 16);
    const end = endHex ? parseInt(endHex, 16) : start;
    for (let cp = start; cp <= end; cp++) codepoints.push(cp);
  }
  return String.fromCodePoint(...codepoints);
}

const SUBSET_TEXT = buildSubsetText(LATIN_RANGES);

// OpenType layout features the app relies on: kerning, standard ligatures,
// contextual alternates, the four figure styles (tabular/lining/proportional
// /oldstyle), plus Fraunces' stylistic sets (cheap to keep -- they are small
// substitution tables, not extra glyph outlines, since the glyphs already
// survive subsetting).
const KEEP_FEATURES = [
  "kern",
  "liga",
  "calt",
  "tnum",
  "lnum",
  "pnum",
  "onum",
  ...Array.from({ length: 20 }, (_, i) => `ss${String(i + 1).padStart(2, "0")}`),
];

// name-table IDs to preserve: 1/2 (family/subfamily, legacy 4-name model),
// 3 (unique identifier), 4 (full name), 6 (PostScript name), 16/17
// (typographic family/subfamily, what a variable font actually uses). Without
// this, hb-subset drops most name records and DevTools' Computed/Fonts panel
// shows a generic "subset" label instead of the real family name.
const PRESERVE_NAME_IDS = [1, 2, 3, 4, 6, 16, 17];

// One entry per subset output file. `source` is a key into SOURCES.
// `variationAxes` is only set for the Fraunces variable font.
const OUTPUTS = [
  {
    file: "fraunces.woff2",
    source: "fraunces",
    variationAxes: {
      SOFT: 0, // drop the soft-serif axis, pinned at the font's own default (0)
      WONK: 1, // drop the "wonky" ink-trap axis, pinned at the font's own
      //         default (1), which is also what Google Fonts serves.
      wght: { min: 300, max: 700 }, // requested range; font supports 100-900
      // opsz is left unspecified, which keeps its full native range (9-144).
    },
  },
  { file: "alegreya-sans-400.woff2", source: "alegreya-sans-regular" },
  { file: "alegreya-sans-400-italic.woff2", source: "alegreya-sans-italic" },
  { file: "alegreya-sans-500.woff2", source: "alegreya-sans-medium" },
  { file: "alegreya-sans-700.woff2", source: "alegreya-sans-bold" },
];

// Files written to the output directory exactly as downloaded: no subsetting,
// no re-encoding. `source` is a key into SOURCES or IBM_PLEX_MONO_ZIP_MEMBERS.
// The OFL files go out with the fonts they cover; the IBM Plex Mono woff2
// files are IBM's own builds (see the header for why they are not subset).
const VERBATIM_OUTPUTS = [
  { file: "ibm-plex-mono-400.woff2", source: "ibm-plex-mono-regular" },
  { file: "ibm-plex-mono-500.woff2", source: "ibm-plex-mono-medium" },
  { file: "OFL-Fraunces.txt", source: "fraunces-license" },
  { file: "OFL-AlegreyaSans.txt", source: "alegreya-sans-license" },
  { file: "OFL-IBMPlexMono.txt", source: "ibm-plex-mono-license" },
];

// ---------------------------------------------------------------------------
// Download + cache helpers
// ---------------------------------------------------------------------------

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Downloads (or reads from cache) a single named source and verifies its
// SHA-256 against the pinned constant above. Throws rather than proceeding
// on a mismatch -- a silently-wrong font is worse than a failed build.
async function ensureCached(name) {
  const entry = SOURCES[name];
  const cachePath = path.join(CACHE_DIR, entry.cacheFile);
  await mkdir(path.dirname(cachePath), { recursive: true });

  let buffer = await readIfExists(cachePath);
  if (!buffer) {
    console.log(`Downloading ${name} from ${entry.url}`);
    const res = await fetch(entry.url);
    if (!res.ok) {
      throw new Error(`Download failed for ${name}: HTTP ${res.status} (${entry.url})`);
    }
    buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(cachePath, buffer);
  }

  const digest = sha256(buffer);
  if (digest !== entry.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${name} (${entry.cacheFile}):\n` +
        `  expected ${entry.sha256}\n` +
        `  got      ${digest}\n` +
        `Refusing to use a file that does not match the pinned hash.`,
    );
  }
  return buffer;
}

// Extracts the two IBM Plex Mono woff2 files and the license out of the zip
// fetched by ensureCached("ibm-plex-mono-zip"), caching each extracted file
// separately so a second run does not need to re-unzip.
async function ensureExtracted(memberName) {
  const member = IBM_PLEX_MONO_ZIP_MEMBERS[memberName];
  const cachePath = path.join(CACHE_DIR, member.cacheFile);
  await mkdir(path.dirname(cachePath), { recursive: true });

  let buffer = await readIfExists(cachePath);
  if (!buffer) {
    const zipBuffer = await ensureCached("ibm-plex-mono-zip");
    const entries = unzipSync(new Uint8Array(zipBuffer), {
      filter: (file) => file.name === member.zipPath,
    });
    const extracted = entries[member.zipPath];
    if (!extracted) {
      throw new Error(`Zip member not found: ${member.zipPath}`);
    }
    buffer = Buffer.from(extracted);
    await writeFile(cachePath, buffer);
  }

  const digest = sha256(buffer);
  if (digest !== member.sha256) {
    throw new Error(
      `SHA-256 mismatch for extracted ${memberName} (${member.cacheFile}):\n` +
        `  expected ${member.sha256}\n` +
        `  got      ${digest}`,
    );
  }
  return buffer;
}

// Resolves the source buffer for a given source name, whichever of the two
// fetch paths (direct raw-file download, or extraction from the IBM zip) it
// needs.
async function resolveSourceBuffer(sourceName) {
  if (sourceName in IBM_PLEX_MONO_ZIP_MEMBERS) {
    return ensureExtracted(sourceName);
  }
  return ensureCached(sourceName);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let outDir = "public/fonts";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      outDir = argv[i + 1];
      i++;
    }
  }
  return { outDir };
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const outPath = path.isAbsolute(outDir) ? outDir : path.join(process.cwd(), outDir);
  await mkdir(outPath, { recursive: true });

  const results = [];
  for (const output of OUTPUTS) {
    const sourceBuffer = await resolveSourceBuffer(output.source);
    const options = {
      targetFormat: "woff2",
      keepFeatures: KEEP_FEATURES,
      preserveNameIds: PRESERVE_NAME_IDS,
    };
    if (output.variationAxes) {
      options.variationAxes = output.variationAxes;
    }
    const subset = await subsetFont(sourceBuffer, SUBSET_TEXT, options);
    const destPath = path.join(outPath, output.file);
    await writeFile(destPath, subset);
    results.push({ file: output.file, bytes: subset.length });
  }

  // Unmodified files: IBM Plex Mono's own woff2 builds and each family's
  // upstream OFL.txt. Their bytes were verified against the pinned SHA-256
  // when they were read, and are written back out untouched.
  for (const output of VERBATIM_OUTPUTS) {
    const buffer = await resolveSourceBuffer(output.source);
    await writeFile(path.join(outPath, output.file), buffer);
    results.push({ file: output.file, bytes: buffer.length });
  }

  // Print a size table.
  const nameWidth = Math.max(...results.map((r) => r.file.length), "file".length);
  console.log("");
  console.log(`${"file".padEnd(nameWidth)}  bytes    KB`);
  console.log(`${"-".repeat(nameWidth)}  -------  ------`);
  let total = 0;
  for (const r of results) {
    total += r.bytes;
    console.log(`${r.file.padEnd(nameWidth)}  ${String(r.bytes).padStart(7)}  ${(r.bytes / 1024).toFixed(1).padStart(6)}`);
  }
  console.log(`${"-".repeat(nameWidth)}  -------  ------`);
  console.log(`${"TOTAL".padEnd(nameWidth)}  ${String(total).padStart(7)}  ${(total / 1024).toFixed(1).padStart(6)}`);
  console.log("");
  console.log(`Wrote ${results.length} files to ${outPath}`);
}

// Run only when executed directly, so importing this module for its exports
// does not download or write anything. realpathSync matches how Node derives
// import.meta.url (symlinks resolved); process.argv[1] is absent under
// `node -e` and in a REPL.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  });
}

export { UNICODE_RANGE_CSS, LATIN_RANGES, OUTPUTS, VERBATIM_OUTPUTS };
