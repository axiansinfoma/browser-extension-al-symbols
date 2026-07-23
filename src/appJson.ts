import * as vscode from "vscode";
import { symbolPackageId, versionMajor } from "./nuget";

export interface Dependency {
  id: string;
  name: string;
  publisher: string;
  version: string;
}

export interface AppManifest {
  name?: string;
  application?: string;
  platform?: string;
  dependencies?: Dependency[];
}

/** A single symbol package to resolve and download. */
export interface PackageSpec {
  /** Human-readable label for progress/errors. */
  label: string;
  /** Lowercased NuGet package id. */
  packageId: string;
  /** Raw dependency parts used for feed-specific package naming schemas. */
  schemaParts?: {
    publisher: string;
    name: string;
    appId: string;
  };
  /** Major version line to stay on. */
  major: number;
  /** Minimum acceptable version. */
  min: string;
}

// App GUIDs of the Microsoft first-party foundational apps, as published on the
// MSSymbols feed (package id: microsoft.<app>[.<country>].symbols[.<appId>]).
const MS_SYSTEM_APPLICATION_APPID = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
const MS_BASE_APPLICATION_APPID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const MS_BUSINESS_FOUNDATION_APPID = "f3552374-a1f2-4356-848e-196002525837";

/**
 * Build a Microsoft first-party symbol package id.
 *
 *  - `country` is inserted before `.symbols` only for the apps that publish
 *    localized variants (Application, Base Application). "w1"/empty means the
 *    base (W1) package with no country segment.
 *  - `appId` (a GUID) is appended for the app packages; Platform/Application
 *    omit it.
 */
function msPackageId(app: string, country: string | undefined, appId?: string): string {
  const c = country && country.toLowerCase() !== "w1" ? `.${country.toLowerCase()}` : "";
  const suffix = appId ? `.${appId}` : "";
  return `microsoft.${app.toLowerCase()}${c}.symbols${suffix}`;
}

/** Find the app.json to operate on; prompts if several exist in the workspace. */
export async function locateAppJson(): Promise<vscode.Uri | undefined> {
  const found = await vscode.workspace.findFiles("**/app.json", "**/node_modules/**");
  if (found.length === 0) {
    return undefined;
  }
  if (found.length === 1) {
    return found[0];
  }
  const pick = await vscode.window.showQuickPick(
    found.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { placeHolder: "Select the app.json to download symbols for" }
  );
  return pick?.uri;
}

export function parseManifest(text: string): AppManifest {
  return JSON.parse(text) as AppManifest;
}

/**
 * Build the list of packages to download from an app.json manifest.
 *
 * When `includeApplicationAndPlatform` is set, the Microsoft first-party
 * foundational symbols are added, all pinned to the `application` major line
 * from app.json:
 *  - Platform              -> microsoft.platform.symbols (the "System" symbols)
 *  - Application (umbrella) -> microsoft.application[.<country>].symbols
 *  - System Application    -> microsoft.systemapplication.symbols.<id>
 *  - Base Application      -> microsoft.baseapplication[.<country>].symbols.<id>
 *  - Business Foundation   -> microsoft.businessfoundation.symbols.<id>
 *
 * Each dependency in app.json maps to <publisher>.<name>.symbols.<id>.
 */
export function buildPackageSpecs(
  app: AppManifest,
  includeApplicationAndPlatform: boolean,
  countryCode?: string
): PackageSpec[] {
  const specs: PackageSpec[] = [];

  if (includeApplicationAndPlatform) {
    const appVersion = app.application ?? "0.0.0.0";
    const appMajor = versionMajor(appVersion);

    // Platform ("System") symbols: no country, no app id, no meaningful minimum.
    specs.push({
      label: "Microsoft Platform (System) symbols",
      packageId: msPackageId("platform", undefined),
      major: appMajor,
      min: "0",
    });
    // System Application and Business Foundation are W1-only (no country variant).
    specs.push({
      label: "Microsoft System Application symbols",
      packageId: msPackageId("systemapplication", undefined, MS_SYSTEM_APPLICATION_APPID),
      major: appMajor,
      min: appVersion,
    });
    specs.push({
      label: "Microsoft Business Foundation symbols",
      packageId: msPackageId("businessfoundation", undefined, MS_BUSINESS_FOUNDATION_APPID),
      major: appMajor,
      min: appVersion,
    });
    // Base Application and the Application umbrella follow the configured country.
    specs.push({
      label: "Microsoft Base Application symbols",
      packageId: msPackageId("baseapplication", countryCode, MS_BASE_APPLICATION_APPID),
      major: appMajor,
      min: appVersion,
    });
    specs.push({
      label: "Microsoft Application symbols",
      packageId: msPackageId("application", countryCode),
      major: appMajor,
      min: appVersion,
    });
  }

  for (const dep of app.dependencies ?? []) {
    specs.push({
      label: `${dep.publisher} / ${dep.name} (${dep.version})`,
      packageId: symbolPackageId(dep.publisher, dep.name, dep.id),
      schemaParts: {
        publisher: dep.publisher,
        name: dep.name,
        appId: dep.id,
      },
      major: versionMajor(dep.version),
      min: dep.version,
    });
  }

  return specs;
}
