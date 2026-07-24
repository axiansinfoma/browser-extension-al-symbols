# AGENTS.md — BC Symbols Downloader

Context for AI coding sessions working on this VS Code extension.

## What this is

A VS Code extension that downloads Business Central **symbol packages** (`.app`
files) from NuGet v3 feeds into a project's `.alpackages` folder, based on the
`app.json` manifest. It exists so AL developers don't have to manually fetch
symbols. Marketplace publisher: `AxiansInfoma`. Repo:
`github.com/axiansinfoma/code-extension-al-symbols`.

## Layout

```
src/
  extension.ts   Command registration + the downloadSymbols orchestration flow.
  appJson.ts     Locate/parse app.json; buildPackageSpecs() turns a manifest
                 into the list of packages to fetch.
  nuget.ts       NuGet v3 protocol: resolve flat2 endpoint, list versions,
                 version comparison/selection, download + extract .app files.
  feeds.ts       Feed config (default public feeds + user feeds) and credential
                 handling via VS Code SecretStorage (never settings.json).
out/             Compiled JS (tsc output). This is what ships in the VSIX.
.github/workflows/  ci.yml (build+package on push/PR), publish.yml (release).
```

Build: `npm run compile` (tsc). Debug: F5 ("Run Extension"). No test suite yet.

## Key behaviors / non-obvious details

- **Package id convention.** BC symbol packages on NuGet are
  `<publisher>.<name>.symbols.<appId>` lowercased, with invalid id chars
  stripped (see `symbolPackageId` / `sanitizeIdPart` in `nuget.ts`).
- **Microsoft first-party symbols** (added in `buildPackageSpecs`, gated by
  `bcSymbols.includeApplicationAndPlatform`) are pinned to the `application`
  major from app.json:
  - `microsoft.platform.symbols` — the "System" symbols (no app id, no country).
  - `microsoft.application[.<country>].symbols` — the umbrella application.
  - `microsoft.systemapplication.symbols.63ca2fa4-4f03-4f2b-a480-172fef340d3f`
  - `microsoft.baseapplication[.<country>].symbols.437dbf0e-84ff-417a-965d-ed2bb9650972`
  - `microsoft.businessfoundation.symbols.f3552374-a1f2-4356-848e-196002525837`
  Only **Application** and **Base Application** have country variants; System
  Application and Business Foundation are W1-only. Country comes from the
  `bcSymbols.countryCode` setting (`w1`/empty = base package). App GUIDs are
  hard-coded constants in `appJson.ts`.
- **Version selection** (`pickVersion` in `nuget.ts`): dependency versions in
  app.json are treated as **minimums**; we pick the highest available version on
  the same **major** line that is `>= min`. NuGet strips trailing-zero
  revisions (`27.0.0.0` → `27.0.0`), so `compareVersions` pads components — the
  two forms compare equal.
- **Feeds are ordered**: default public feeds first (Microsoft `MSSymbolsV2`,
  AppSource `AppSourceSymbols` on the `dynamicssmb2` Azure DevOps org), then
  user feeds from `bcSymbols.feeds`. First feed with a matching version wins.
- **Credentials** are stored in `SecretStorage` keyed by feed URL, never in
  settings. PAT feeds send the token as HTTP Basic password (`pat:<token>`).
- **Caching**: a marker file under `<targetDir>/.cache/<pkgId>@<version>` marks
  an already-extracted package so re-runs skip it.

## Verifying feed/package assumptions

Package ids and available versions can be checked against the live public feed
without any auth. Resolve the `PackageBaseAddress` (flat2) from the service
index, then GET `<flat2>/<lowercased-id>/index.json` for the versions list.
`node` (with global `fetch`) is the easiest way — `python3` in this env lacks
the `json` module.

## CI/CD

- `ci.yml`: on every push/PR — `npm ci`, `npm run compile`, `vsce package`
  (validates the manifest), uploads the `.vsix` as an artifact.
- `publish.yml`: on GitHub **release published** — verifies the release tag
  (minus a leading `v`) matches `package.json` `version`, packages, runs
  `vsce publish`, and attaches the `.vsix` to the release. Requires the
  **`VSCE_PAT`** repo secret (an Azure DevOps PAT with Marketplace → Manage
  scope for the `AxiansInfoma` publisher). Also runnable via
  `workflow_dispatch` with a `dry_run` toggle.

**Release flow:** bump `version` in `package.json` → commit → create a GitHub
release tagged `v<version>` → `publish.yml` ships it.

## Conventions

- `out/` (tsc output) and `node_modules/` are gitignored; CI/publish compile
  fresh from source. `.vscodeignore` controls what ships in the VSIX — source,
  maps, `.github`, and dev files are excluded, so only `out/`, `package.json`,
  and the README ship.
- TypeScript, 2-space indent, ES modules-style imports compiled to CommonJS.
