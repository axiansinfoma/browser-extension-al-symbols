import * as vscode from "vscode";
import { Headers } from "./nuget";

export type AuthKind = "none" | "pat" | "basic";

export interface FeedConfig {
  name: string;
  url: string;
  authentication: AuthKind;
  packageNameSchema?: string;
}

/** Public feeds shipped by default; toggled by bcSymbols.useDefaultFeeds. */
export const DEFAULT_FEEDS: FeedConfig[] = [
  {
    name: "MS Symbols",
    url: "https://pkgs.dev.azure.com/dynamicssmb2/DynamicsBCPublicFeeds/_packaging/MSSymbolsV2/nuget/v3/index.json",
    authentication: "none",
  },
  {
    name: "AppSource Symbols",
    url: "https://pkgs.dev.azure.com/dynamicssmb2/DynamicsBCPublicFeeds/_packaging/AppSourceSymbols/nuget/v3/index.json",
    authentication: "none",
  },
];

/** Resolve the ordered feed list: default public feeds first, then user feeds. */
export function getConfiguredFeeds(): FeedConfig[] {
  const config = vscode.workspace.getConfiguration("bcSymbols");
  const useDefaults = config.get<boolean>("useDefaultFeeds", true);
  const extra = config.get<Partial<FeedConfig>[]>("feeds", []) ?? [];

  const feeds: FeedConfig[] = useDefaults ? [...DEFAULT_FEEDS] : [];
  for (const f of extra) {
    if (!f.url || !f.name) {
      continue;
    }
    feeds.push({
      name: f.name,
      url: f.url,
      authentication: (f.authentication as AuthKind) ?? "none",
      packageNameSchema: typeof f.packageNameSchema === "string" ? f.packageNameSchema : undefined,
    });
  }
  return feeds;
}

// ---------------------------------------------------------------------------
// Credentials. Secrets are stored in VS Code's SecretStorage, keyed by feed
// URL — never written to settings.json.
// ---------------------------------------------------------------------------
const SECRET_PREFIX = "bcSymbols.cred:";

interface StoredCredential {
  token?: string; // pat
  username?: string; // basic
  password?: string; // basic
}

function secretKey(url: string): string {
  return SECRET_PREFIX + url;
}

async function readCredential(secrets: vscode.SecretStorage, url: string): Promise<StoredCredential | undefined> {
  const raw = await secrets.get(secretKey(url));
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as StoredCredential;
  } catch {
    return undefined;
  }
}

export async function clearCredential(secrets: vscode.SecretStorage, url: string): Promise<void> {
  await secrets.delete(secretKey(url));
}

function toAuthHeader(feed: FeedConfig, cred: StoredCredential): Headers {
  if (feed.authentication === "pat" && cred.token) {
    // Azure DevOps accepts the PAT as the HTTP Basic password with any username.
    return { Authorization: `Basic ${Buffer.from(`pat:${cred.token}`).toString("base64")}` };
  }
  if (feed.authentication === "basic" && cred.username !== undefined) {
    return {
      Authorization: `Basic ${Buffer.from(`${cred.username}:${cred.password ?? ""}`).toString("base64")}`,
    };
  }
  return {};
}

/** Prompt the user for a feed's credential based on its authentication kind. */
export async function promptCredential(feed: FeedConfig): Promise<StoredCredential | undefined> {
  if (feed.authentication === "pat") {
    const token = await vscode.window.showInputBox({
      title: `Personal Access Token — ${feed.name}`,
      prompt: "Token is stored in the OS secret store, not in settings.",
      password: true,
      ignoreFocusOut: true,
    });
    return token ? { token } : undefined;
  }
  if (feed.authentication === "basic") {
    const username = await vscode.window.showInputBox({
      title: `Username — ${feed.name}`,
      ignoreFocusOut: true,
    });
    if (username === undefined) {
      return undefined;
    }
    const password = await vscode.window.showInputBox({
      title: `Password — ${feed.name}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      return undefined;
    }
    return { username, password };
  }
  return undefined;
}

/**
 * Return the Authorization headers for a feed, prompting for (and storing)
 * credentials on first use if none are cached. Returns {} for public feeds.
 */
export async function resolveAuthHeaders(
  secrets: vscode.SecretStorage,
  feed: FeedConfig,
  promptIfMissing = true
): Promise<Headers> {
  if (feed.authentication === "none") {
    return {};
  }
  let cred = await readCredential(secrets, feed.url);
  if (!cred && promptIfMissing) {
    cred = await promptCredential(feed);
    if (cred) {
      await secrets.store(secretKey(feed.url), JSON.stringify(cred));
    }
  }
  return cred ? toAuthHeader(feed, cred) : {};
}

/** Store (or overwrite) a credential for a feed after prompting. */
export async function setCredentialInteractive(secrets: vscode.SecretStorage, feed: FeedConfig): Promise<boolean> {
  const cred = await promptCredential(feed);
  if (!cred) {
    return false;
  }
  await secrets.store(secretKey(feed.url), JSON.stringify(cred));
  return true;
}
