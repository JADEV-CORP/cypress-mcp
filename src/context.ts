// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { ConfigLoader } from "./services/config-loader.js";
import { ProcessManager } from "./services/process-manager.js";
import { OutputParser } from "./services/output-parser.js";
import { SpecFinder } from "./services/spec-finder.js";
import { ScreenshotResolver } from "./services/screenshot-resolver.js";
import { StateStore } from "./services/state-store.js";
import { DEFAULT_CONFIG } from "./types/config.js";
import type { ToolContext } from "./types/index.js";
import type { Logger } from "./utils/logger.js";

/**
 * The Mocha reporter passed to `cypress run`. It ships next to dist/ in the
 * package, so this resolves from the bundle and from the sources alike.
 */
export const REPORTER_PATH = fileURLToPath(
  new URL("../reporter/cypress-mcp-reporter.cjs", import.meta.url),
);

/** Services for one Cypress project, shared by the MCP server and the CLI. */
export function createToolContext(projectRoot: string, logger: Logger): ToolContext {
  const configLoader = new ConfigLoader(projectRoot, logger);
  return {
    projectRoot,
    processManager: new ProcessManager(projectRoot, logger, REPORTER_PATH),
    outputParser: new OutputParser(logger),
    configLoader,
    specFinder: new SpecFinder(projectRoot, logger),
    screenshotResolver: new ScreenshotResolver(
      projectRoot,
      async () => {
        try {
          return (await configLoader.load()).screenshotsDir;
        } catch {
          return DEFAULT_CONFIG.screenshotsDir;
        }
      },
      logger,
    ),
    stateStore: new StateStore(),
    logger,
  };
}
