import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  buildPackageSpecs,
  locateAppJson,
  parseManifest,
  PackageSpec,
} from "./appJson";
import {
  clearCredential,
  FeedConfig,
  getConfiguredFeeds,
  resolveAuthHeaders,
  setCredentialInteractive,
} from "./feeds";
import {
  applyPackageSchema,
  hasRequiredPackageSchemaPlaceholders,
  downloadNupkg,
  extractApps,
  Headers,
  listVersions,
  pickVersion,
  resolveFlatBase,
} from "./nuget";

interface ResolvedFeed {
  config: FeedConfig;
  flatBase: string;
  headers: Headers;
  packageNameSchema?: string;
}

const output = vscode.window.createOutputChannel("BC Symbols");

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("bcSymbols.downloadSymbols", () => downloadSymbols(context)),
    vscode.commands.registerCommand("bcSymbols.manageCredentials", () => manageCredentials(context)),
    vscode.commands.registerCommand("bcSymbols.clearCredentials", () => clearCredentials(context))
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------
async function downloadSymbols(context: vscode.ExtensionContext): Promise<void> {
  const appJsonUri = await locateAppJson();
  if (!appJsonUri) {
    vscode.window.showErrorMessage("BC Symbols: no app.json found in the workspace.");
    return;
  }

  let specs: PackageSpec[];
  try {
    const manifest = parseManifest(fs.readFileSync(appJsonUri.fsPath, "utf8"));
    const config = vscode.workspace.getConfiguration("bcSymbols");
    specs = buildPackageSpecs(
      manifest,
      config.get<boolean>("includeApplicationAndPlatform", true),
      config.get<string>("countryCode", "w1")
    );
  } catch (err) {
    vscode.window.showErrorMessage(`BC Symbols: failed to read app.json — ${errorMessage(err)}`);
    return;
  }

  if (specs.length === 0) {
    vscode.window.showInformationMessage("BC Symbols: nothing to download (no dependencies in app.json).");
    return;
  }

  const config = vscode.workspace.getConfiguration("bcSymbols");
  const targetName = config.get<string>("targetDirectory", ".alpackages");
  const appDir = path.dirname(appJsonUri.fsPath);
  const outDir = path.resolve(appDir, targetName);
  const cacheDir = path.join(outDir, ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  output.clear();
  output.appendLine(`Target: ${outDir}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "BC: Downloading symbols from NuGet",
      cancellable: true,
    },
    async (progress, token) => {
      const feeds = await resolveFeeds(context, progress);
      if (feeds.length === 0) {
        vscode.window.showErrorMessage("BC Symbols: no usable feeds. Check bcSymbols.feeds and credentials.");
        return;
      }

      const downloaded: string[] = [];
      const skipped: string[] = [];
      const missing: string[] = [];

      for (const spec of specs) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({ message: spec.label });
        try {
          const result = await processSpec(spec, feeds, outDir, cacheDir);
          if (result === "cached") {
            skipped.push(spec.label);
          } else if (result) {
            downloaded.push(`${spec.label} -> ${result}`);
          } else {
            missing.push(spec.label);
          }
        } catch (err) {
          missing.push(`${spec.label} (${errorMessage(err)})`);
          output.appendLine(`  ERROR: ${spec.label}: ${errorMessage(err)}`);
        }
      }

      output.appendLine("");
      output.appendLine(`Downloaded: ${downloaded.length}, up-to-date: ${skipped.length}, missing: ${missing.length}`);

      if (missing.length > 0) {
        const choice = await vscode.window.showWarningMessage(
          `BC Symbols: ${downloaded.length} downloaded, ${skipped.length} up-to-date, ${missing.length} could not be resolved.`,
          "Show Log"
        );
        if (choice === "Show Log") {
          output.show();
        }
      } else {
        vscode.window.showInformationMessage(
          `BC Symbols: ${downloaded.length} downloaded, ${skipped.length} up-to-date.`
        );
      }
    }
  );
}

/**
 * Resolve a single package against the ordered feed list: first feed that has
 * a matching version wins. Returns the chosen version, "cached", or undefined
 * when the package is on no feed.
 */
async function processSpec(
  spec: PackageSpec,
  feeds: ResolvedFeed[],
  outDir: string,
  cacheDir: string
): Promise<string | "cached" | undefined> {
  for (const feed of feeds) {
    const packageId = packageIdForFeed(spec, feed);
    let versions: string[];
    try {
      versions = await listVersions(feed.flatBase, packageId, feed.headers);
    } catch (err) {
      output.appendLine(`  ${packageId}: feed "${feed.config.name}" lookup failed — ${errorMessage(err)}`);
      continue;
    }
    const version = pickVersion(versions, spec.major, spec.min);
    if (!version) {
      continue;
    }

    const marker = path.join(cacheDir, `${packageId}@${version}`);
    if (fs.existsSync(marker)) {
      output.appendLine(`  ${spec.label}: already present (${version}) — skipping`);
      return "cached";
    }

    output.appendLine(`  ${spec.label}: downloading ${version} from ${feed.config.name} (${packageId})`);
    const nupkg = await downloadNupkg(feed.flatBase, packageId, version, feed.headers);
    const files = extractApps(nupkg, outDir);
    if (files.length === 0) {
      throw new Error("package contained no .app file");
    }
    fs.writeFileSync(marker, "");
    output.appendLine(`    extracted: ${files.join(", ")}`);
    return version;
  }
  return undefined;
}

/** Resolve auth + flat2 endpoint for every configured feed, skipping unreachable ones. */
async function resolveFeeds(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string }>
): Promise<ResolvedFeed[]> {
  const resolved: ResolvedFeed[] = [];
  for (const feed of getConfiguredFeeds()) {
    progress.report({ message: `Connecting to ${feed.name}` });
    try {
      const headers = await resolveAuthHeaders(context.secrets, feed);
      const flatBase = await resolveFlatBase(feed.url, headers);
      const normalizedSchema = normalizePackageSchema(feed.packageNameSchema, feed.name);
      resolved.push({ config: feed, flatBase, headers, packageNameSchema: normalizedSchema });
      output.appendLine(`Feed OK: ${feed.name} (${feed.authentication})`);
    } catch (err) {
      output.appendLine(`Feed FAILED: ${feed.name} — ${errorMessage(err)}`);
      vscode.window.showWarningMessage(`BC Symbols: feed "${feed.name}" is unavailable — ${errorMessage(err)}`);
    }
  }
  return resolved;
}

function normalizePackageSchema(schema: string | undefined, feedName: string): string | undefined {
  if (!schema) {
    return undefined;
  }
  if (hasRequiredPackageSchemaPlaceholders(schema)) {
    return schema;
  }
  output.appendLine(
    `Feed "${feedName}": packageNameSchema ignored (must include {publisher}, {name}, and {appId}).`
  );
  return undefined;
}

function packageIdForFeed(spec: PackageSpec, feed: ResolvedFeed): string {
  if (!feed.packageNameSchema || !spec.schemaParts) {
    return spec.packageId;
  }
  return applyPackageSchema(feed.packageNameSchema, spec.schemaParts);
}

// ---------------------------------------------------------------------------
// Credential management commands
// ---------------------------------------------------------------------------
async function pickPrivateFeed(placeHolder: string): Promise<FeedConfig | undefined> {
  const feeds = getConfiguredFeeds().filter((f) => f.authentication !== "none");
  if (feeds.length === 0) {
    vscode.window.showInformationMessage(
      "BC Symbols: no private feeds are configured. Add one under the bcSymbols.feeds setting."
    );
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    feeds.map((f) => ({ label: f.name, description: `${f.authentication} · ${f.url}`, feed: f })),
    { placeHolder }
  );
  return pick?.feed;
}

async function manageCredentials(context: vscode.ExtensionContext): Promise<void> {
  const feed = await pickPrivateFeed("Select a private feed to set credentials for");
  if (!feed) {
    return;
  }
  const ok = await setCredentialInteractive(context.secrets, feed);
  if (ok) {
    vscode.window.showInformationMessage(`BC Symbols: credentials saved for "${feed.name}".`);
  }
}

async function clearCredentials(context: vscode.ExtensionContext): Promise<void> {
  const feed = await pickPrivateFeed("Select a private feed to clear credentials for");
  if (!feed) {
    return;
  }
  await clearCredential(context.secrets, feed.url);
  vscode.window.showInformationMessage(`BC Symbols: credentials cleared for "${feed.name}".`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
