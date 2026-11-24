// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional tool groups. Every tool definition costs context in clients that
 * load tool lists upfront, so the default set is the four tools of the
 * run-and-fix loop and the rest is opt-in with `--caps`.
 */
export const CAPABILITIES = {
  /** cypress_analyze_spec: structure, visits, intercepts and fixtures of one spec */
  analyze: ["cypress_analyze_spec"],
  /** cypress_get_config and cypress_get_env: resolved config, env keys */
  config: ["cypress_get_config", "cypress_get_env"],
} as const;

/**
 * Groups that no longer exist. A client config written for an older version
 * still passes them, so the startup warning says what happened to them.
 */
const REMOVED_CAPS: ReadonlyMap<string, string> = new Map([
  [
    "legacy",
    "legacy was removed in 0.5: the README maps each 0.2 tool name to its replacement, https://github.com/jams4code/cypress-mcp#upgrading",
  ],
]);

export type Capability = keyof typeof CAPABILITIES;

export const DEFAULT_TOOLS = [
  "cypress_run",
  "cypress_get_failure",
  "cypress_list_specs",
  "cypress_doctor",
] as const;

export interface CapsSelection {
  readonly caps: ReadonlySet<Capability>;
  /** Names given that are not a capability, reported once at startup */
  readonly unknown: readonly string[];
}

/**
 * Capabilities from `--caps a,b`, `--caps=a,b` (repeatable) and the
 * CYPRESS_MCP_CAPS environment variable, which suits clients where adding
 * arguments is awkward. `all` turns every group on.
 */
export function parseCaps(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): CapsSelection {
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--caps") {
      names.push(...split(argv[i + 1] ?? ""));
      i++;
    } else if (arg.startsWith("--caps=")) {
      names.push(...split(arg.slice("--caps=".length)));
    }
  }
  names.push(...split(env["CYPRESS_MCP_CAPS"] ?? ""));

  const caps = new Set<Capability>();
  const unknown: string[] = [];
  for (const name of names) {
    if (name === "all") {
      for (const cap of Object.keys(CAPABILITIES) as Capability[]) caps.add(cap);
    } else if (Object.hasOwn(CAPABILITIES, name)) {
      // hasOwn, not `in`: "constructor" is not a group.
      caps.add(name as Capability);
    } else {
      unknown.push(name);
    }
  }
  return { caps, unknown };
}

/** Details of the startup warning for `--caps` names that are not a group. */
export function unknownCapsWarning(unknown: readonly string[]): Record<string, unknown> {
  const notes = unknown.flatMap((name) => REMOVED_CAPS.get(name) ?? []);
  return {
    unknown: [...unknown],
    known: [...Object.keys(CAPABILITIES), "all"],
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

function split(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}
