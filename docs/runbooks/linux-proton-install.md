# Can a Windows game on Steam Proton get entry A1 installed and restored on Thor?

Owner: Chris. Environment: Thor, the bare-metal Linux workstation this fork runs on directly (not a compose or cluster environment). Given: a checkout of this repository on `develop` or `feat/proton-install-core` at commit `fbc7e71` or later, Node and `7z` on `PATH`, and at least one Steam library holding a Windows game already launched once with Proton so its `compatdata/<appid>` prefix exists.

Written for commit `fbc7e71df2373afecc35f7b52ccf38cc647e5d24` (`feat/u9-integration`, wave 2 of
`proton-install-core`, review remedy batch C): the route gate call at `main.js:1633`, the
driver-wording render at `main.js:1703`, and everything the earlier `1963e18` and `5fa199c`
commits on the same branch wired (the route gate's job channel, the ensure step by route, the
compiler check's release directory, the copy step's entry/manifest/guard/release-directory/
tracked-copy). A later commit that changes any of these call sites updates this file in the
same commit, since a record of a run is superseded rather than edited
read with the runbook that supersedes it.

## Index

The one runbook under `docs/runbooks/` today is this file.

## 0. Work from the checkout

Every command below is relative to the fork's checkout, and the profile's inner path names this one checkout's Electron binary, so the working directory is this exact checkout.

```bash
cd /home/chperso/20051/project-files/dlss-5-linux-proton-swapper && git log -1 --format=%h && pwd
```

Expect: a short commit hash (`d638aef` or a descendant) and `/home/chperso/20051/project-files/dlss-5-linux-proton-swapper`.

If not: `apparmor_parser` prints `File linux/apparmor/dlss5-swapper-electron not found, skipping...` from any other directory, which is what a run from the home directory printed on 2026-09-21; `cd` into the checkout and start again.

## 1. Load the AppArmor profile

```bash
sudo apparmor_parser --replace --write-cache \
  linux/apparmor/dlss5-swapper-electron \
  && sudo aa-status --show=profiles | grep -F 'dlss5-swapper-electron'
```

Expect: one line, `dlss5-swapper-electron (enforce)` or `dlss5-swapper-electron
(unconfined)` depending on the installed `apparmor` version's `aa-status` wording; either way
the name appears, which is `apparmor_parser`'s own confirmation that the profile compiled and
loaded.

If not: no line at all means the parser failed silently or the path is wrong; run
`apparmor_parser --replace linux/apparmor/dlss5-swapper-electron` without `--write-cache` and
read its own error, most often a stale `abi <abi/5.0>,` line against an older kernel's
AppArmor ABI, or the profile's inner path,
`<checkout>/node_modules/electron/dist/electron`, not existing yet because `npm ci` (below)
has not run. The profile is a fixed-path grant of `userns` alone (Annex D names no hook here;
this is the sandbox precondition requirements D9 sets, not a Linux behaviour hook): it confines
nothing, so a stale load left over from a deleted checkout is safe to leave until step 8.

## 2. Copy the Windows release's shader compiler into the payload

`proton-install-core~16~3` places Microsoft's `d3dcompiler_47.dll`, taken from your own copy
of upstream's matching Windows release, beside `nvngx_dlssnr.dll` in the app's payload so
`~17~2`'s compiler check and the copy step's release-sourced placement row both find it.

The matching Windows release is upstream's `v2.2.7`, the version `package.json` carries at `24bd2ac`: `https://github.com/rakanki911/DLSS5-Swapper/releases/download/v2.2.7/DLSS5-Swapper-2.2.7-portable.exe`, an NSIS self-extractor holding `$PLUGINSDIR/app-64.7z`, which holds `d3dcompiler_47.dll` at its root. Both unpack with `7z` on Linux; the manager did so on 2026-09-21 and the file measured 4,916,728 bytes at SHA-256 `af7b99be1b8770c0e4d18e43b04e81d11bdeb667fa6b07ade7a88f4c5676bf9a`, Annex A's row.

```bash
T=$(mktemp -d) && curl -sL -o "$T/portable.exe" https://github.com/rakanki911/DLSS5-Swapper/releases/download/v2.2.7/DLSS5-Swapper-2.2.7-portable.exe \
  && 7z e -y -o"$T" "$T/portable.exe" '$PLUGINSDIR/app-64.7z' >/dev/null && 7z e -y -o"$T/rel" "$T/app-64.7z" d3dcompiler_47.dll >/dev/null \
  && sha256sum "$T/rel/d3dcompiler_47.dll"
[ -e payload ] || 7z x -y -o"$T/relpayload" "$T/app-64.7z" resources/payload >/dev/null && [ -e payload ] || cp -a "$T/relpayload/resources/payload" payload
find payload -iname nvngx_dlssnr.dll
cp "$T/rel/d3dcompiler_47.dll" "$(dirname "$(find payload -iname nvngx_dlssnr.dll | head -1)")/"
```

Expect: `sha256sum` prints `af7b99be1b8770c0e4d18e43b04e81d11bdeb667fa6b07ade7a88f4c5676bf9a`; the `find` command prints one path, typically `payload/streamline/
nvngx_dlssnr.dll`; after the `cp`, `ls "$(dirname ...)"` lists `d3dcompiler_47.dll` beside it.

From source the app reads `payload/` beside `main.js`, which `npm run payload` assembles from NVIDIA's DLSS files and pinned components; a checkout that has never run it has no `payload/`, so the command above unpacks the release's shipped `resources/payload/` (streamline, feeder, the ReShade add-on set, 256 MB) into it, the same files the published build carries. The manager did this on Thor on 2026-09-21 and the app's own `scanSource` printed `ok: true, hasNeuralRendering: true, payload: 11` over it.

If not: `find` prints nothing because the unpack step was skipped; once the
payload exists, a `cp` that reports nothing but leaves the file missing means the destination
directory itself does not exist yet; `mkdir -p` it first.

## 3. Build

```bash
make build
```

Expect: `npm ci` runs to completion with no error and no `npm ERR!` line; `node_modules/`
now holds the lockfile's exact versions.

If not: a lockfile/manifest mismatch prints `npm ERR! Invalid: lock file's ... does not
satisfy ...`; `rules.md`'s lockfile-currency marker ties `package-lock.json` to upstream's own
merges, so a mismatch here means the checkout is between an upstream merge and its lockfile
update, not a fork problem to fix by hand.

## 4. Test

```bash
make test
npm run test:linux
```

Expect: both commands run the same script, `scripts/test-linux.js`, and both print a line
ending `Annex E failures seen, 0 unexpected, 0 passed unexpectedly, 0 Linux failures: ok`,
with the same file count on both runs, and exit 0.

If not: an `unexpected` count above zero names a test in the printed list that failed for
a reason Annex E does not carry; a `passed unexpectedly` count above zero means an Annex E row
has been fixed upstream and needs removing from the specification, not from the test. Either
way this is a code defect, not an environment one: do not proceed to step 6.

## 5. Start the app

```bash
npm start
```

Expect: the Electron window opens and the library view loads. The first run after step 1
is the one that proves the AppArmor load actually mattered: without it, this step is the one
that fails.

If not: `FATAL:setuid_sandbox_host.cc(163)` on stdout, immediately, with no window, means
step 1 did not load, or loaded a profile naming a different `electron` binary than the one
`npm ci` just installed (a fresh `npm ci` replaces `node_modules/electron`, but not the loaded
kernel policy naming its old inode); re-run step 1. Any other startup error is unrelated to
the sandbox and is a build or environment problem, not this feature's.

## 6. Install entry A1 into a listed game

In the running app: pick a Windows game already launched once with Proton (its
`compatdata/<appid>` prefix must exist, or the Proton context is unresolved and the install
still proceeds under `~5~5` but the job log names it), choose the OptiScaler DLSS-NR route,
and confirm the install.

Expect: the confirmation dialog names the detected GPU with its driver, and, only where
this app cannot judge a Linux driver number against its Windows-sourced support table, one
extra clause beside the driver (`~26~1`'s wording, rendered by this remedy at `main.js:1703`).
The job log carries `linux-record-written`, then `linux-launch-options` naming the entry and
its launch-options cell, and the install reports success. `<game folder>/_DLSS5_Backup/
manifest.json` now exists, and `dxgi.dll`, `nvngx.dll_dlssnr.dll`, `OptiScaler.ini` and
`d3dcompiler_47.dll` all sit beside the game's executable.

If not: `errLinuxRouteNotAllowed` names the API/bitness pair Annex A does not list for
this game; that is the game, not a defect. `errLinuxReleaseFileMissing` names a release file
this checkout's payload does not carry — re-check step 2. `errLinuxNativeGame` on a game with
no detected Windows executable is `main.js:1633`'s new hook working as intended, not a
failure: the game is a native Linux title and this feature does not apply to it.

## 7. Restore it

In the running app, choose Restore for the same game.

Expect: the job log carries one `linux-restore-sweep` event per file the sweep visits and
finds unchanged (none, on a game nothing else touched since the install), `dxgi.dll` is back
to its pre-install bytes, `nvngx.dll_dlssnr.dll`, `OptiScaler.ini` and `d3dcompiler_47.dll`
are gone, and the restore reports success. `_DLSS5_Backup/originals/` still exists afterwards
(backups are never deleted, per ADR-004); no `_DLSS5_Backup/swept/` directory exists unless
something else wrote into the game folder between install and restore.

If not: a `linux-restore-sweep` event naming `outcome: 'moved'` for a file you recognise
as your own means something wrote into the executable folder after the install; that file is
now under `_DLSS5_Backup/swept/<uuid>/`, not deleted. `linux-restore-incomplete` naming a
`kept` entry means a link or a wrong-kind object is sitting where a tracked file belongs;
`backup` in that entry's record names where the original still is.

## 8. Unload the AppArmor profile

```bash
sudo apparmor_parser --remove linux/apparmor/dlss5-swapper-electron \
  && sudo rm -f /var/cache/apparmor/*/dlss5-swapper-electron \
  && sudo aa-status --show=profiles | grep -c -F 'dlss5-swapper-electron'
```

Expect: `0`, with exit status 1 (the no-match case from `grep -c`, not an error).

If not: a count of `1` or more means `--remove` did not take; re-run it and check
`apparmor_parser`'s own exit status before the `rm`, which only clears the boot-time cache and
never touches the running kernel's policy.
