# BC Symbols Downloader

VS Code extension that downloads the Business Central symbol packages referenced
by your `app.json` from NuGet feeds and drops the `.app` files into `.alpackages`.
It is a port of the original `scripts/restore-symbols.sh`, with support for
additional and private feeds.

## Command

- **BC: Download Symbols from Nuget** — resolves `application`, `platform`, and
  every `dependencies[]` entry in the nearest `app.json` and downloads matching
  symbols into `.alpackages`.
- **BC: Manage NuGet Feed Credentials** — store a credential for a private feed.
- **BC: Clear NuGet Feed Credentials** — remove a stored credential.

## How resolution works

| app.json entry | NuGet package id |
| --- | --- |
| `application` | `microsoft.application.symbols` |
| `platform`    | `microsoft.platform.symbols` (tracks the `application` major, since `platform` is a placeholder) |
| `dependencies[]` | `<publisher>.<name>.symbols.<id>` — publisher/name keep `. _ -` and drop other characters; lowercased. A feed may override this with a [custom name schema](#custom-package-name-schema). |

For each package the highest version on the requested **major** line that is
`>=` the app.json version is chosen (BC dependency versions are minimums).
NuGet strips trailing-zero revisions, so `27.0.0.0` in app.json matches `27.0.0`
on the feed. Downloaded `(package, version)` pairs are cached in
`.alpackages/.cache/`, so re-runs only fetch what changed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `bcSymbols.useDefaultFeeds` | `true` | Include the public MS + AppSource feeds. |
| `bcSymbols.feeds` | `[]` | Additional feeds (searched after the defaults). |
| `bcSymbols.targetDirectory` | `.alpackages` | Output directory, relative to `app.json`. |
| `bcSymbols.includeApplicationAndPlatform` | `true` | Also fetch Application + Platform symbols. |

### Adding a private feed

```jsonc
"bcSymbols.feeds": [
  {
    "name": "My Company Symbols",
    "url": "https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/nuget/v3/index.json",
    "authentication": "pat",     // "none" | "pat" | "basic"
    "packageNameSchema": "{publisher}.{name}.symbols.{appId}"
  }
]
```

- `pat` — an Azure DevOps Personal Access Token (sent as the HTTP Basic
  password). Prompted on first use.
- `basic` — username + password.
- Credentials are stored in the OS secret store via VS Code Secret Storage —
  **never** written to `settings.json`. Feeds are searched in order and the
  first one that has a matching package version wins, so if a private feed
  should take precedence, set `bcSymbols.useDefaultFeeds` to `false` or list it
  first.

### Custom package name schema

Feeds that publish symbols under a different id convention than Microsoft's can
set an optional, feed-scoped `packageNameSchema`. When present, it replaces the
default `<publisher>.<name>.symbols.<id>` naming when the extension looks up and
downloads packages **from that feed**.

```jsonc
"packageNameSchema": "{publisher}.{name}.symbols.{appId}"
```

- **Placeholders** are substituted from each `dependencies[]` entry:
  - `{publisher}` — the dependency's `publisher`
  - `{name}` — the dependency's `name`
  - `{appId}` — the dependency's `id` (the app GUID)
- **All three placeholders are optional**, but a schema must include at least
  one of `{name}` or `{appId}` so that packages can be told apart (`{publisher}`
  alone is not enough — dependencies often share a publisher). A schema that
  satisfies neither is ignored (the feed falls back to the default naming) and a
  note is written to the **BC Symbols** output channel. Placeholder names are
  case-insensitive, so `{appId}` and `{appid}` behave the same.
- The substituted `{publisher}` and `{name}` values are sanitized the same way
  as the default id (only `. _ -` are kept; other characters are dropped) and
  the whole resulting id is lowercased. Any literal text you put between
  placeholders is preserved.
- Each placeholder accepts an optional `:separator` modifier that rewrites the
  word-separator characters (space, `.`, `-`, `_`) in that value before
  sanitizing. Use it when a feed normalizes separators differently from the app
  name — e.g. a dependency named `10001-Stadt_Neu-Ulm` published as
  `10001_stadt_neu_ulm` is matched with `"packageNameSchema": "{name:_}"`.
- The schema applies to dependency packages (`dependencies[]`) only. The
  Application and Platform first-party packages always keep their built-in
  `microsoft.*.symbols` naming, regardless of the feed's schema.

## Develop

```bash
npm install
npm run compile     # or: npm run watch
```

Press **F5** ("Run Extension") to launch an Extension Development Host.
