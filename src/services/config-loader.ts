// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CypressMcpConfig, RawServerConfig } from "../types/config.js";
import {
  CYPRESS_CONFIG_FILES,
  DEFAULT_CONFIG,
  SERVER_CONFIG_FILE,
} from "../types/config.js";
import { ConfigNotFoundError } from "../utils/errors.js";
import { normalizePath } from "../utils/paths.js";
import type { Logger } from "../utils/logger.js";
import { maskCode, readLiteral, skipBlank } from "../utils/js-scan.js";

/** Size and modification time of each file a config was built from. */
type Fingerprint = Map<string, string>;

export class ConfigLoader {
  private cached: { config: CypressMcpConfig; fingerprint: Fingerprint } | null = null;
  /** Build in progress; concurrent callers share it, so `reading` has one writer. */
  private pending: Promise<CypressMcpConfig> | null = null;
  /** Files read while building the config being loaded, with their stamp at read time */
  private reading: Fingerprint = new Map();

  constructor(
    private readonly projectRoot: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolved config. Cached, but rebuilt as soon as any file it was built from
   * (Cypress config, its relative imports, the support file,
   * cypress-mcp.config.json) changes, appears or disappears, so edits made
   * during a session apply to the next tool call.
   */
  async load(): Promise<CypressMcpConfig> {
    if (this.cached && (await this.isUnchanged(this.cached.fingerprint))) {
      return this.cached.config;
    }

    this.pending ??= this.rebuild().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async rebuild(): Promise<CypressMcpConfig> {
    // Stamp every candidate file first, so creating a config file that did
    // not exist yet also invalidates the cache.
    this.reading = new Map();
    for (const file of [SERVER_CONFIG_FILE, ...CYPRESS_CONFIG_FILES]) {
      const absolute = path.join(this.projectRoot, file);
      this.reading.set(absolute, await stamp(absolute));
    }

    const config = await this.build();
    this.cached = { config, fingerprint: this.reading };
    return config;
  }

  private async isUnchanged(fingerprint: Fingerprint): Promise<boolean> {
    for (const [file, previous] of fingerprint) {
      if ((await stamp(file)) !== previous) {
        this.logger.info("Config input changed, reloading", { file });
        return false;
      }
    }
    return true;
  }

  /** Read a file and remember its stamp, taken before the read. */
  private async readTracked(absolute: string): Promise<string> {
    this.reading.set(absolute, await stamp(absolute));
    return fs.readFile(absolute, "utf-8");
  }

  private async build(): Promise<CypressMcpConfig> {
    const serverConfig = await this.loadServerConfig();
    const configFile = await this.findCypressConfig(serverConfig?.cypressConfigFile);
    if (!configFile) {
      throw new ConfigNotFoundError(this.projectRoot);
    }

    const configHints = await this.loadConfigHints(configFile);

    const config: CypressMcpConfig = {
      projectRoot: normalizePath(this.projectRoot),
      cypressConfigFile: normalizePath(configFile),
      // Only an explicit choice is passed on: Cypress picks its own default
      // (the project's config, then Electron) when --browser is absent.
      ...(serverConfig?.defaultBrowser
        ? { defaultBrowser: serverConfig.defaultBrowser }
        : {}),
      defaultTimeout: serverConfig?.defaultTimeout ?? DEFAULT_CONFIG.defaultTimeout,
      screenshotsDir:
        serverConfig?.screenshotsDir ??
        configHints.screenshotsDir ??
        DEFAULT_CONFIG.screenshotsDir,
      downloadsDir:
        serverConfig?.downloadsDir ??
        configHints.downloadsDir ??
        DEFAULT_CONFIG.downloadsDir,
      specPattern: normalizePatterns(
        serverConfig?.specPattern ??
          configHints.specPattern ??
          DEFAULT_CONFIG.specPattern,
      ),
      supportFile: serverConfig?.supportFile ?? configHints.supportFile,
      titleFilterSupport:
        serverConfig?.titleFilterSupport ??
        (await this.detectTitleFilterSupport(configFile, configHints.supportFile)),
      failureContext: serverConfig?.failureContext ?? DEFAULT_CONFIG.failureContext,
      // Same precedence as Cypress itself: env var over config file
      projectId:
        serverConfig?.projectId ??
        nonEmpty(process.env["CYPRESS_PROJECT_ID"]) ??
        configHints.projectId,
    };

    this.logger.info("Config loaded", {
      configFile,
      projectRoot: this.projectRoot,
    });

    return config;
  }

  private async findCypressConfig(override?: string): Promise<string | null> {
    if (override) {
      const fullPath = path.isAbsolute(override)
        ? override
        : path.join(this.projectRoot, override);

      try {
        await fs.access(fullPath);
        this.reading.set(fullPath, await stamp(fullPath));
        return path.isAbsolute(override)
          ? normalizePath(path.relative(this.projectRoot, fullPath))
          : normalizePath(override);
      } catch {
        throw new ConfigNotFoundError(this.projectRoot, override);
      }
    }

    for (const file of CYPRESS_CONFIG_FILES) {
      const fullPath = path.join(this.projectRoot, file);
      try {
        await fs.access(fullPath);
        return file;
      } catch {
        // File doesn't exist, try next
      }
    }
    return null;
  }

  private async loadServerConfig(): Promise<RawServerConfig | null> {
    const configPath = path.join(this.projectRoot, SERVER_CONFIG_FILE);
    try {
      const raw = await this.readTracked(configPath);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        this.logger.info("Server config loaded", { path: configPath });
        return parsed as RawServerConfig;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Invalidate cached config (useful after config changes) */
  invalidate(): void {
    this.cached = null;
  }

  private async loadConfigHints(configFile: string): Promise<ConfigHints> {
    const visited = new Set<string>();
    return this.loadConfigHintsFromFile(configFile, visited, 0);
  }

  private async loadConfigHintsFromFile(
    filePath: string,
    visited: Set<string>,
    depth: number,
  ): Promise<ConfigHints> {
    if (depth > 4) {
      return {};
    }

    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);
    const normalized = normalizePath(absolute);

    if (visited.has(normalized)) {
      return {};
    }

    visited.add(normalized);

    let content = "";
    try {
      content = await this.readTracked(absolute);
    } catch {
      return {};
    }

    let mergedHints = extractConfigHints(content);

    for (const importedFile of resolveRelativeImports(absolute, content)) {
      const importedHints = await this.loadConfigHintsFromFile(
        importedFile,
        visited,
        depth + 1,
      );
      mergedHints = mergeConfigHints(mergedHints, importedHints);
    }

    return mergedHints;
  }

  private async detectTitleFilterSupport(
    configFile: string,
    supportFile?: string | false,
  ): Promise<boolean> {
    const filesToScan = new Set<string>();
    const configAbsolute = path.isAbsolute(configFile)
      ? configFile
      : path.join(this.projectRoot, configFile);

    filesToScan.add(normalizePath(configAbsolute));

    try {
      const configContent = await this.readTracked(configAbsolute);
      for (const importedFile of resolveRelativeImports(configAbsolute, configContent)) {
        filesToScan.add(normalizePath(importedFile));
      }
    } catch {
      // Ignore and continue with best-effort scanning.
    }

    if (typeof supportFile === "string") {
      const supportAbsolute = path.isAbsolute(supportFile)
        ? supportFile
        : path.join(this.projectRoot, supportFile);
      filesToScan.add(normalizePath(supportAbsolute));
    } else if (supportFile === undefined) {
      // Not set in the config: Cypress uses its default support file.
      for (const candidate of DEFAULT_SUPPORT_FILES) {
        filesToScan.add(normalizePath(path.join(this.projectRoot, candidate)));
      }
    }

    for (const file of filesToScan) {
      try {
        // Tracked so that wiring @cypress/grep into the support file mid
        // session enables cypress_run_test without a restart.
        const content = await this.readTracked(file);
        if (TITLE_FILTER_PATTERN.test(content)) {
          return true;
        }
      } catch {
        // Ignore unreadable files while probing for grep support.
      }
    }

    return false;
  }
}

/** "size:mtime" of a file, or "missing". */
async function stamp(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

interface ConfigHints {
  readonly projectId?: string;
  readonly specPattern?: readonly string[];
  readonly supportFile?: string | false;
  readonly screenshotsDir?: string;
  readonly downloadsDir?: string;
}

/** Cypress's default e2e support file, `cypress/support/e2e.{js,jsx,ts,tsx}`. */
const DEFAULT_SUPPORT_FILES = ["js", "jsx", "ts", "tsx"].map(
  (ext) => `cypress/support/e2e.${ext}`,
);

const TITLE_FILTER_PATTERN =
  /(@cypress\/grep|cypress-grep|registerCypressGrep|grepFilterSpecs|grepOmitFiltered)/;

function normalizePatterns(value: string | readonly string[]): string[] {
  const patterns = Array.isArray(value) ? value : [value];
  return patterns.map((pattern) => normalizePath(pattern));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Hints for e2e runs, read from the config text. Cypress accepts specPattern
 * and supportFile only inside the `e2e` and `component` objects, and lets
 * either override a global option such as screenshotsFolder. So each key is
 * read inside `e2e: {...}` first, then outside both objects; a value inside
 * `component: {...}` is never used. Component runs take their specs from the
 * spec argument and need none of these. A value that is not a plain literal
 * (a variable, a spread, a concatenation) counts as missing, so the next
 * place, then the default, applies.
 */
function extractConfigHints(content: string): ConfigHints {
  const scope = new E2eScope(content);
  return {
    projectId: scope.read("projectId", readString),
    specPattern: scope.read("specPattern", readStringList),
    supportFile: scope.read("supportFile", readSupportFile),
    screenshotsDir:
      scope.read("screenshotsFolder", readString) ??
      scope.read("screenshotsDir", readString),
    downloadsDir:
      scope.read("downloadsFolder", readString) ?? scope.read("downloadsDir", readString),
  };
}

/** Start and end offsets of an object literal, braces included. */
type Range = readonly [start: number, end: number];

/** Reads a value at the offset just after `key:`, undefined when it is not a literal. */
type ValueReader<T> = (content: string, at: number) => T | undefined;

class E2eScope {
  /** The content with strings and comments blanked: keys and braces in code only */
  private readonly mask: string;
  private readonly e2e: readonly Range[];
  private readonly component: readonly Range[];

  constructor(private readonly content: string) {
    this.mask = maskCode(content);
    this.e2e = objectRanges(this.mask, "e2e");
    this.component = objectRanges(this.mask, "component");
  }

  /** The first readable value of `key`: inside e2e, then outside both testing types. */
  read<T>(key: string, reader: ValueReader<T>): T | undefined {
    const inE2e: number[] = [];
    const outside: number[] = [];
    // Not after "." either: `cond ? config.specPattern : x` is no key.
    for (const match of this.mask.matchAll(
      new RegExp(`(?<![\\w$.])${key}\\s*:\\s*`, "g"),
    )) {
      const at = match.index + match[0].length;
      if (within(this.e2e, at)) {
        inE2e.push(at);
      } else if (!within(this.component, at)) {
        outside.push(at);
      }
    }
    for (const at of [...inE2e, ...outside]) {
      const value = reader(this.content, at);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }
}

/** Every `name: {...}` object in the mask. */
function objectRanges(mask: string, name: string): Range[] {
  const ranges: Range[] = [];
  for (const match of mask.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*:\\s*\\{`, "g"))) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = mask.length;
    for (let i = open; i < mask.length; i++) {
      if (mask[i] === "{") {
        depth++;
      } else if (mask[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    ranges.push([open, close]);
  }
  return ranges;
}

function within(ranges: readonly Range[], at: number): boolean {
  return ranges.some(([start, end]) => at > start && at < end);
}

/** Whether the value read so far is the whole value: the next token ends it. */
function endsValue(content: string, index: number): boolean {
  const next = content[skipBlank(content, index)];
  return next === undefined || next === "," || next === "}";
}

function readString(content: string, at: number): string | undefined {
  const literal = readLiteral(content, at);
  return literal && !literal.dynamic && endsValue(content, literal.end)
    ? literal.text
    : undefined;
}

/** A string, or an array of strings read literal by literal, so "[jt]" in a glob does not end it. */
function readStringList(content: string, at: number): readonly string[] | undefined {
  if (content[at] !== "[") {
    const single = readString(content, at);
    return single === undefined ? undefined : [single];
  }

  const values: string[] = [];
  let index = skipBlank(content, at + 1);
  while (content[index] !== "]") {
    const literal = readLiteral(content, index);
    if (!literal || literal.dynamic) {
      return undefined;
    }
    values.push(literal.text);
    index = skipBlank(content, literal.end);
    if (content[index] === ",") {
      index = skipBlank(content, index + 1);
    } else if (content[index] !== "]") {
      return undefined;
    }
  }
  return values.length > 0 && endsValue(content, index + 1) ? values : undefined;
}

function readSupportFile(content: string, at: number): string | false | undefined {
  if (content.startsWith("false", at) && endsValue(content, at + "false".length)) {
    return false;
  }
  return readString(content, at);
}

function resolveRelativeImports(absolutePath: string, content: string): string[] {
  const imports = new Set<string>();
  const importPatterns = [
    /import\s+[^'"]*?from\s*["'](\.[^"']+)["']/g,
    /import\s*["'](\.[^"']+)["']/g,
    /export\s+[^'"]*?from\s*["'](\.[^"']+)["']/g,
    /require\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];

  for (const pattern of importPatterns) {
    for (const match of content.matchAll(pattern)) {
      const importPath = match[1];
      if (importPath) {
        const resolved = resolveImportPath(path.dirname(absolutePath), importPath);
        if (resolved) {
          imports.add(resolved);
        }
      }
    }
  }

  return [...imports];
}

function resolveImportPath(baseDir: string, importPath: string): string | null {
  const candidates = path.extname(importPath)
    ? [importPath]
    : [
        `${importPath}.ts`,
        `${importPath}.js`,
        `${importPath}.mjs`,
        `${importPath}.cjs`,
        path.join(importPath, "index.ts"),
        path.join(importPath, "index.js"),
      ];

  for (const candidate of candidates) {
    const absolute = path.resolve(baseDir, candidate);
    if (existsSync(absolute)) {
      return absolute;
    }
  }

  return null;
}

function mergeConfigHints(primary: ConfigHints, fallback: ConfigHints): ConfigHints {
  return {
    projectId: primary.projectId ?? fallback.projectId,
    specPattern: primary.specPattern ?? fallback.specPattern,
    supportFile: primary.supportFile ?? fallback.supportFile,
    screenshotsDir: primary.screenshotsDir ?? fallback.screenshotsDir,
    downloadsDir: primary.downloadsDir ?? fallback.downloadsDir,
  };
}
