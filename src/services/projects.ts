// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// Monorepos: the server root (--cwd) may hold several Cypress projects, each
// in a folder with its own cypress.config.*. A tool finds its project from the
// `project` argument, from the spec path, or alone when there is only one.
// Paths shown to the agent stay relative to the server root.
//
// The search is refused from the disk root, the home folder and the folders
// above it (where clients such as Claude Desktop start servers), and bounded
// elsewhere, so a tool call cannot list or run unrelated repositories or
// hang on a large tree.
import { existsSync, readdir, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import type { ToolContext } from "../types/index.js";
import { CYPRESS_CONFIG_FILES } from "../types/config.js";
import { CypressMcpError, InvalidArgumentError } from "../utils/errors.js";
import { isBroadRoot, normalizePath, resolveInsideRoot } from "../utils/paths.js";

/** Config files that mark a project folder. */
const PROJECT_MARKERS: readonly string[] = CYPRESS_CONFIG_FILES;
const DISCOVERY_DEPTH = 5;
// About a second on an SSD; a monorepo root reads far fewer, as node_modules
// and .git are skipped.
const MAX_DISCOVERY_FOLDERS = 20_000;
// For slow or network file systems, where the folder count comes too late.
const DISCOVERY_TIMEOUT_MS = 5_000;

const CWD_HINT =
  "Start the server with --cwd set to the folder that holds cypress.config.*.";

/** Project folders found under the server root. */
export interface Discovery {
  /** Relative to the server root, "." for the root itself, sorted */
  readonly projects: string[];
  /** Set when a limit ended the search before it read the whole tree, e.g. "after 20000 folders" */
  readonly stoppedEarly?: string;
}

export interface DiscoveryOptions {
  /** The home folder: it and the folders above it are never searched. Default: os.homedir() */
  readonly home?: string;
  readonly maxFolders?: number;
  readonly timeoutMs?: number;
}

/** No project to work on, or several to choose from. */
export class ProjectRequiredError extends CypressMcpError {
  private constructor(
    message: string,
    code: "CONFIG_NOT_FOUND" | "PROJECT_REQUIRED",
    suggestion: string,
    /** The search behind the error, when there was one */
    readonly discovery?: Discovery,
  ) {
    super(message, code, suggestion);
    this.name = "ProjectRequiredError";
  }

  /** None or several projects found below a root without a config of its own. */
  static afterSearch(serverRoot: string, discovery: Discovery): ProjectRequiredError {
    const { projects, stoppedEarly } = discovery;
    if (projects.length === 0) {
      return new ProjectRequiredError(
        stoppedEarly
          ? `No cypress.config.* in the server root ${serverRoot} or the subfolders read before the search stopped ${stoppedEarly}.`
          : `No cypress.config.* in the server root ${serverRoot} or its subfolders.`,
        "CONFIG_NOT_FOUND",
        CWD_HINT,
        discovery,
      );
    }
    return new ProjectRequiredError(
      stoppedEarly
        ? `The server root holds Cypress projects: ${projects.join(", ")}, and maybe more: the search stopped ${stoppedEarly}. Pass project, or a spec path inside one of them.`
        : `The server root holds several Cypress projects: ${projects.join(", ")}. Pass project, or a spec path inside one of them.`,
      "PROJECT_REQUIRED",
      "Set project to one of the folders listed.",
      discovery,
    );
  }

  static missingRoot(serverRoot: string): ProjectRequiredError {
    return new ProjectRequiredError(
      `The server root ${serverRoot} does not exist or is not a folder.`,
      "CONFIG_NOT_FOUND",
      CWD_HINT,
    );
  }

  static broadRoot(serverRoot: string): ProjectRequiredError {
    return new ProjectRequiredError(
      `No cypress.config.* in the server root ${serverRoot}, probably the folder the MCP client started the server in. cypress-mcp does not search the disk root, the home folder or a folder above it for projects: start the server with --cwd <project folder>.`,
      "CONFIG_NOT_FOUND",
      "Start the server with --cwd <project folder>: the folder that holds cypress.config.*, or the monorepo root.",
    );
  }
}

export interface ProjectSelection {
  readonly ctx: ToolContext;
  /** Project folder relative to the server root, "" for the root itself */
  readonly prefix: string;
  /** The given spec arguments, made relative to the project */
  readonly specs: string[];
}

export class ProjectRegistry {
  private readonly contexts = new Map<string, ToolContext>();
  private readonly home: string;
  private readonly maxFolders: number;
  private readonly timeoutMs: number;

  constructor(
    readonly serverRoot: string,
    private readonly create: (projectRoot: string) => ToolContext,
    options: DiscoveryOptions = {},
  ) {
    this.home = options.home ?? os.homedir();
    this.maxFolders = options.maxFolders ?? MAX_DISCOVERY_FOLDERS;
    this.timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  }

  /** The context of a project folder (absolute), created on first use. */
  context(projectRoot: string): ToolContext {
    const key = path.resolve(projectRoot);
    let ctx = this.contexts.get(key);
    if (!ctx) {
      ctx = this.create(key);
      this.contexts.set(key, ctx);
    }
    return ctx;
  }

  /** Every context created so far, to stop their runs on shutdown. */
  all(): ToolContext[] {
    return [...this.contexts.values()];
  }

  /**
   * The project a call is about. `project` wins; then the server root when it
   * has a config (the common case, unchanged since 0.1); then the folder of
   * the first spec path that has a config; then the only project found.
   */
  async select(input: {
    project?: string;
    specs?: readonly string[];
  }): Promise<ProjectSelection> {
    const specs = [...(input.specs ?? [])];
    this.checkRoot();

    if (input.project !== undefined && input.project.trim() !== "") {
      const root = resolveInsideRoot(this.serverRoot, input.project.trim());
      if (!root || !hasConfig(root)) {
        const { projects, stoppedEarly } = await this.discover();
        const found = projects.join(", ") || "none";
        throw new InvalidArgumentError(
          `project must be a folder inside the server root that holds a cypress.config.*: ${input.project}. Found: ${found}${stoppedEarly ? ` (search stopped ${stoppedEarly})` : ""}.`,
        );
      }
      return this.selection(root, specs);
    }

    if (hasConfig(this.serverRoot)) {
      return this.selection(this.serverRoot, specs);
    }

    for (const spec of specs) {
      const fromSpec = this.projectOfPath(spec.replace(/:\d+(?::\d+)?$/, ""));
      if (fromSpec) {
        return this.selection(fromSpec, specs);
      }
    }

    const discovery = await this.discover();
    // A search that stopped early may have missed the project meant.
    if (discovery.projects.length === 1 && !discovery.stoppedEarly) {
      return this.selection(path.join(this.serverRoot, discovery.projects[0]!), specs);
    }
    throw ProjectRequiredError.afterSearch(this.serverRoot, discovery);
  }

  /** Project folders under the server root, within the folder and time limits. */
  async discover(): Promise<Discovery> {
    this.checkRoot();
    let folders = 0;
    const tooMany = new AbortController();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    // Counts the folders read: the glob has no limit of its own.
    const countingReaddir = ((...args: Parameters<typeof readdir>) => {
      folders += 1;
      if (folders > this.maxFolders) tooMany.abort();
      return readdir(...args);
    }) as typeof readdir;

    // An aborted search resolves with what it found so far.
    const configs = await glob(
      PROJECT_MARKERS.map((file) => `**/${file}`),
      {
        cwd: this.serverRoot,
        ignore: ["**/node_modules/**", "**/.git/**"],
        deep: DISCOVERY_DEPTH,
        fs: { readdir: countingReaddir },
        signal: AbortSignal.any([tooMany.signal, timeout]),
      },
    );
    const projects = [
      ...new Set(configs.map((file) => normalizePath(path.dirname(file)))),
    ].sort();
    const stoppedEarly = tooMany.signal.aborted
      ? `after ${this.maxFolders} folders`
      : timeout.aborted
        ? `after ${this.timeoutMs / 1000} s`
        : undefined;
    return stoppedEarly ? { projects, stoppedEarly } : { projects };
  }

  /**
   * Refuses a root that does not exist, and one too broad to search without a
   * config of its own: the agent could otherwise list and run the projects of
   * every repository on the machine.
   */
  private checkRoot(): void {
    if (!isDirectory(this.serverRoot)) {
      throw ProjectRequiredError.missingRoot(this.serverRoot);
    }
    if (!hasConfig(this.serverRoot) && isBroadRoot(this.serverRoot, this.home)) {
      throw ProjectRequiredError.broadRoot(this.serverRoot);
    }
  }

  private selection(projectRoot: string, specs: string[]): ProjectSelection {
    const prefix = normalizePath(path.relative(this.serverRoot, projectRoot));
    return {
      ctx: this.context(projectRoot),
      prefix,
      specs: specs.map((spec) => toProjectRelative(spec, prefix)),
    };
  }

  /** Nearest folder above a server-root-relative path that holds a config. */
  private projectOfPath(relative: string): string | undefined {
    const absolute = resolveInsideRoot(this.serverRoot, relative);
    if (!absolute) return undefined;
    let current = path.dirname(absolute);
    while (current.startsWith(this.serverRoot) && current !== this.serverRoot) {
      if (hasConfig(current)) return current;
      current = path.dirname(current);
    }
    return undefined;
  }
}

function hasConfig(dir: string): boolean {
  return PROJECT_MARKERS.some((file) => existsSync(path.join(dir, file)));
}

function isDirectory(dir: string): boolean {
  return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** `apps/web/cypress/e2e/a.cy.ts` to `cypress/e2e/a.cy.ts` for project `apps/web`. */
function toProjectRelative(spec: string, prefix: string): string {
  if (!prefix) return spec;
  const normalized = normalizePath(spec.trim());
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : spec;
}

/** A project-relative path as the agent sees it, relative to the server root. */
export function displayPath(prefix: string, projectRelative: string): string {
  return prefix ? path.posix.join(prefix, projectRelative) : projectRelative;
}
