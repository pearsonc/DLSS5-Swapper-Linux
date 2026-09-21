# The before-install record fixture pair

`tree/` is a game folder and `record.json` the before-install record it yields, the
`manifest.linuxBefore` array Annex B of `proton-install-core-spec.md` defines. Annex D's
Linux entry install, copy step row (`linux.installEntry(`, proton-install-core~34~4 to
~39~3) must yield `record.json` from `tree/`; the Restore row's sweep (`linux.restoreSweep(`,
~22~6 to ~38~1) reads `record.json`; the pair is the one fixture the two agree by.

## The shape

One entry per file, directory, symbolic link or other entry under the executable folder, the
install's backup directory `_DLSS5_Backup/` excluded, found by a walk that follows no symbolic
link, in the order a sorted `readdir` visits them, each `{ rel, kind, mode, size, mtimeMs }`,
`rel` relative to the game folder, as Annex B of `proton-install-core-spec.md` defines the
before-install record. This fixture's executable sits at the tree root, so it cannot separate
the executable folder from the game folder; it holds no `link` or `other` kind either.

| Field | Value |
|---|---|
| `rel` | The path relative to the game folder, `/` separators |
| `kind` | `file`, `dir`, `link` or `other`, as `lstat` reports it |
| `mode` | The low twelve bits of `st_mode`, as a number: `420` is `0644`, `493` is `0755` |
| `size` | The byte count; a file only, the key absent otherwise |
| `mtimeMs` | The modification time in whole milliseconds, floored; a file only, the key absent otherwise |

## The tree

| `rel` | Kind | Mode | Bytes | `mtimeMs` |
|---|---|---|---|---|
| `Game.exe` | file | `0644` | 62 | 1789862400000, 2026-09-20T00:00:00Z |
| `data` | dir | `0755` | | |
| `data/config.ini` | file | `0644` | 23 | 1789862401000 |
| `data/sub` | dir | `0755` | | |
| `data/sub/level.dat` | file | `0644` | 10 | 1789862402000 |

## Before a test walks it

Git keeps neither modification times nor a mode beyond the executable bit, so a test copies
`tree/` into a temporary folder and sets what `record.json` carries before walking it: `mode`
with `fs.chmodSync`, and `mtimeMs` with `fs.utimesSync(path, atime, mtimeMs / 1000)`. The
modes here are what a checkout under `umask 022` yields, so `chmod` is the safe form rather than
the necessary one; `utimes` is always necessary.
