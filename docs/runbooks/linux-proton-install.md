# Can a Windows game on Steam Proton get entry A1 installed and restored on Thor?

Owner: Chris. Environment: Thor, the bare-metal Linux workstation this fork runs on directly
(not a compose or cluster environment). Given: a checkout of this repository on `develop` or
`feat/proton-install-core` at commit `fa5880d` or later, Node and `7z` on `PATH`, and at
least one Steam library holding a Windows game already launched once with Proton so its
`compatdata/<appid>` prefix exists.

Written for commit `fa5880da6fbb3da91c56e5140d4aebbc1dea54ae` (`feat/u9-integration`, wave 2 of
`proton-install-core`, review remedy batch C): the route gate call at `main.js:1633`, the
driver-wording render at `main.js:1700`, and everything the earlier `3fd7920` and `23e665e`
commits on the same branch wired (the route gate's job channel, the ensure step by route, the
compiler check's release directory, the copy step's entry/manifest/guard/release-directory/
tracked-copy). A later commit that changes any of these call sites updates this file in the
same commit, since a record of a run is superseded rather than edited
read with the runbook that supersedes it.

## Index

The one runbook under `docs/runbooks/` today is this file.

## 1. Load the AppArmor profile

```bash
sudo apparmor_parser --replace --write-cache \
  linux/apparmor/dlss5-swapper-electron \
  && sudo aa-status --show=profiles | grep -F 'dlss5-swapper-electron'
```

**Expect:** one line, `dlss5-swapper-electron (enforce)` or `dlss5-swapper-electron
(unconfined)` depending on the installed `apparmor` version's `aa-status` wording; either way
the name appears, which is `apparmor_parser`'s own confirmation that the profile compiled and
loaded.

**If not:** no line at all means the parser failed silently or the path is wrong; run
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

```bash
find payload -iname nvngx_dlssnr.dll
cp /path/to/your/windows-release/d3dcompiler_47.dll "$(dirname "$(find payload -iname nvngx_dlssnr.dll | head -1)")/"
```

**Expect:** the `find` command prints one path, typically `payload/streamline/
nvngx_dlssnr.dll`; after the `cp`, `ls "$(dirname ...)"` lists `d3dcompiler_47.dll` beside it.

**If not:** `find` prints nothing because the payload has not been fetched yet; that is a
separate, upstream step (the app ships a payload directory beside `main.js` from source, or
under the packaged app's resources), not something this runbook or `~16~3` covers. Once the
payload exists, a `cp` that reports nothing but leaves the file missing means the destination
directory itself does not exist yet; `mkdir -p` it first.

## 3. Build

```bash
make build
```

**Expect:** `npm ci` runs to completion with no error and no `npm ERR!` line; `node_modules/`
now holds the lockfile's exact versions.

**If not:** a lockfile/manifest mismatch prints `npm ERR! Invalid: lock file's ... does not
satisfy ...`; `rules.md`'s lockfile-currency marker ties `package-lock.json` to upstream's own
merges, so a mismatch here means the checkout is between an upstream merge and its lockfile
update, not a fork problem to fix by hand.

## 4. Test

```bash
make test
npm run test:linux
```

**Expect:** both commands run the same script, `scripts/test-linux.js`, and both print a line
ending `Annex E failures seen, 0 unexpected, 0 passed unexpectedly, 0 Linux failures: ok`,
with the same file count on both runs, and exit 0.

**If not:** an `unexpected` count above zero names a test in the printed list that failed for
a reason Annex E does not carry; a `passed unexpectedly` count above zero means an Annex E row
has been fixed upstream and needs removing from the specification, not from the test. Either
way this is a code defect, not an environment one: do not proceed to step 6.

## 5. Start the app

```bash
npm start
```

**Expect:** the Electron window opens and the library view loads. The first run after step 1
is the one that proves the AppArmor load actually mattered: without it, this step is the one
that fails.

**If not:** `FATAL:setuid_sandbox_host.cc(163)` on stdout, immediately, with no window, means
step 1 did not load, or loaded a profile naming a different `electron` binary than the one
`npm ci` just installed (a fresh `npm ci` replaces `node_modules/electron`, but not the loaded
kernel policy naming its old inode); re-run step 1. Any other startup error is unrelated to
the sandbox and is a build or environment problem, not this feature's.

## 6. Install entry A1 into a listed game

In the running app: pick a Windows game already launched once with Proton (its
`compatdata/<appid>` prefix must exist, or the Proton context is unresolved and the install
still proceeds under `~5~5` but the job log names it), choose the OptiScaler DLSS-NR route,
and confirm the install.

**Expect:** the confirmation dialog names the detected GPU with its driver, and, only where
this app cannot judge a Linux driver number against its Windows-sourced support table, one
extra clause beside the driver (`~26~1`'s wording, rendered by this remedy at `main.js:1700`).
The job log carries `linux-record-written`, then `linux-launch-options` naming the entry and
its launch-options cell, and the install reports success. `<game folder>/_DLSS5_Backup/
manifest.json` now exists, and `dxgi.dll`, `nvngx.dll_dlssnr.dll`, `OptiScaler.ini` and
`d3dcompiler_47.dll` all sit beside the game's executable.

**If not:** `errLinuxRouteNotAllowed` names the API/bitness pair Annex A does not list for
this game; that is the game, not a defect. `errLinuxReleaseFileMissing` names a release file
this checkout's payload does not carry — re-check step 2. `errLinuxNativeGame` on a game with
no detected Windows executable is `main.js:1633`'s new hook working as intended, not a
failure: the game is a native Linux title and this feature does not apply to it.

## 7. Restore it

In the running app, choose Restore for the same game.

**Expect:** the job log carries one `linux-restore-sweep` event per file the sweep visits and
finds unchanged (none, on a game nothing else touched since the install), `dxgi.dll` is back
to its pre-install bytes, `nvngx.dll_dlssnr.dll`, `OptiScaler.ini` and `d3dcompiler_47.dll`
are gone, and the restore reports success. `_DLSS5_Backup/originals/` still exists afterwards
(backups are never deleted, per ADR-004); no `_DLSS5_Backup/swept/` directory exists unless
something else wrote into the game folder between install and restore.

**If not:** a `linux-restore-sweep` event naming `outcome: 'moved'` for a file you recognise
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

**Expect:** `0`, with exit status 1 (the no-match case from `grep -c`, not an error).

**If not:** a count of `1` or more means `--remove` did not take; re-run it and check
`apparmor_parser`'s own exit status before the `rm`, which only clears the boot-time cache and
never touches the running kernel's policy.
