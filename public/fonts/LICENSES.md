# Font licenses

All three families are licensed under the [SIL Open Font License
1.1](https://openfontlicense.org) (OFL). The license text for each is in the
file beside the fonts, copied unchanged from the upstream repository, and so
is its copyright line:

| Family | License file | Copyright line (from that file) |
|---|---|---|
| Fraunces | [`OFL-Fraunces.txt`](./OFL-Fraunces.txt) | Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces) |
| Alegreya Sans | [`OFL-AlegreyaSans.txt`](./OFL-AlegreyaSans.txt) | Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans) |
| IBM Plex Mono | [`OFL-IBMPlexMono.txt`](./OFL-IBMPlexMono.txt) | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" |

The OFL lets you embed, redistribute and bundle these fonts with software,
including commercially, provided the copyright notice and license text travel
with every copy. Keep the `OFL-*.txt` files with the `.woff2` files if you
copy them elsewhere.

## What was done to each file

| Files | Form |
|---|---|
| `ibm-plex-mono-400.woff2`, `ibm-plex-mono-500.woff2` | IBM's own Latin-1 builds (`IBMPlexMono-Regular-Latin1.woff2` and `IBMPlexMono-Medium-Latin1.woff2`) from the pinned release, byte-for-byte, unmodified. |
| `fraunces.woff2`, `alegreya-sans-*.woff2` | Latin subsets made by `scripts/fonts.mjs`. |

"Plex" is a Reserved Font Name. Under OFL section 3 a modified version, which
a subset is, may not use a Reserved Font Name, so the IBM Plex Mono files are
IBM's own builds rather than a subset made here. Fraunces and Alegreya Sans
declare no Reserved Font Name, so the OFL permits subsetting them.

## Sources

| Font | Upstream repo | Version / commit |
|---|---|---|
| Fraunces (variable) | [`undercasetype/Fraunces`](https://github.com/undercasetype/Fraunces) | `master` @ `7ccdec31c6028118dce3e47fe864e3744460371d` (2026-09-16) |
| Alegreya Sans | [`huertatipografica/Alegreya-Sans`](https://github.com/huertatipografica/Alegreya-Sans) | `master` @ `b19cf06866bb153cc0ed3ea9d9131b180c48fee4` (2026-09-16) |
| IBM Plex Mono | [`IBM/plex`](https://github.com/IBM/plex) | release `@ibm/plex-mono@2.5.0` (2026-06-11) |

Fraunces and Alegreya Sans are pulled from a pinned commit rather than a
tagged release. IBM Plex Mono is pulled from a tagged release. Exact source
URLs and SHA-256 hashes for every download, including the extracted IBM Plex
Mono files and the three license files, are recorded in `scripts/fonts.mjs`.
Run `npm run fonts` to regenerate everything in this directory.
