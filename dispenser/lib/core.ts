export type ConfigSource = "env" | "json" | ".env" | "default" | "none";

export type SelectionState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; selectedModelIds: string[] };

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function normalizeApiKey(value: string | undefined): string {
  return (value ?? "").trim().replace(/^Bearer\s+/i, "");
}

export function computeDefaultSelectedIds(input: {
  remoteIds: string[];
  savedSelection?: string[];
  currentProviderIds?: string[];
}): string[] {
  const remote = new Set(input.remoteIds);
  const base = input.savedSelection ?? input.currentProviderIds ?? [];
  return sortUnique(base.filter((id) => remote.has(id)));
}

export function resolveMageneConfigFromSources(input: {
  env: Record<string, string | undefined>;
  envFile: Record<string, string | undefined>;
  /** json 凭证存储(magene-credentials.json);按字段优先于 envFile。 */
  stored?: { baseUrl?: string; apiKey?: string };
  defaultBaseUrl: string;
}): {
  baseUrl: string;
  baseUrlSource: ConfigSource;
  apiKey: string;
  apiKeySource: ConfigSource;
} {
  const envBaseUrl = input.env.MAGENE_BASE_URL?.trim();
  const storedBaseUrl = input.stored?.baseUrl?.trim();
  const fileBaseUrl = input.envFile.MAGENE_BASE_URL?.trim();
  const envApiKey = normalizeApiKey(input.env.MAGENE_API_KEY);
  const storedApiKey = normalizeApiKey(input.stored?.apiKey);
  const fileApiKey = normalizeApiKey(input.envFile.MAGENE_API_KEY);

  return {
    baseUrl: envBaseUrl || storedBaseUrl || fileBaseUrl || input.defaultBaseUrl,
    baseUrlSource: envBaseUrl ? "env" : storedBaseUrl ? "json" : fileBaseUrl ? ".env" : "default",
    apiKey: envApiKey || storedApiKey || fileApiKey || "",
    apiKeySource: envApiKey ? "env" : storedApiKey ? "json" : fileApiKey ? ".env" : "none",
  };
}

export function determineStartupModelIds(input: {
  remoteIds: string[];
  savedSelectionState: SelectionState;
}): string[] {
  const remoteIds = sortUnique(input.remoteIds);
  if (input.savedSelectionState.kind !== "valid") return remoteIds;
  const remote = new Set(remoteIds);
  return sortUnique(input.savedSelectionState.selectedModelIds.filter((id) => remote.has(id)));
}

export function selectionStateLabel(state: SelectionState): string {
  if (state.kind === "valid") return "present";
  if (state.kind === "invalid") return "invalid (ignored)";
  return "missing";
}

export function buildDoctorLines(input: {
  baseUrl: string;
  baseUrlSource: string;
  apiKeyPresent: boolean;
  apiKeySource: string;
  remoteStatus: string;
  overrideModelCount: number;
  selectionStateLabel: string;
  selectedModelCount: number;
  discoveredModelCount: number;
  sourceCounts: { override: number; remote: number; known: number; inferred: number };
  configServer: string;
  remoteConfig: string;
  reportPath: string;
}): string[] {
  return [
    "Magene doctor",
    `baseUrl: ${input.baseUrl}`,
    `baseUrl source: ${input.baseUrlSource}`,
    `apiKey: ${input.apiKeyPresent ? `present (${input.apiKeySource})` : "missing"}`,
    `remote /models: ${input.remoteStatus}`,
    `Config server: ${input.configServer}`,
    `Remote config: ${input.remoteConfig}`,
    `Override models: ${input.overrideModelCount}`,
    `Selection file: ${input.selectionStateLabel}`,
    `Selected models: ${input.selectedModelCount}`,
    `Discovered models: ${input.discoveredModelCount}`,
    `Sources: known=${input.sourceCounts.known}, remote=${input.sourceCounts.remote}, inferred=${input.sourceCounts.inferred}, override=${input.sourceCounts.override}`,
    `Report: ${input.reportPath}`,
  ];
}
