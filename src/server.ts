// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "./types/index.js";
import type { Capability } from "./caps.js";
import { registerAllTools } from "./tools/index.js";

export { REPORTER_PATH } from "./context.js";

// package.json sits one level above both src/ and dist/, and npm always ships it.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const SERVER_VERSION = version;

/**
 * Sent at startup. Claude Code loads only tool names and these lines until a
 * tool is needed, so they say what the server is for and how the tools chain.
 */
export const SERVER_INSTRUCTIONS = [
  "cypress-mcp runs this project's Cypress tests and reports failures compactly.",
  "- cypress_run {spec} runs a spec (testName for one test) and returns one line per failure (file:line, error, screenshot) and a runId.",
  '- cypress_get_failure {runId} adds source excerpts, diffs and stacks; view "tests", "screenshots" or "output" for more. Pass your own runId: "last" can be another agent\'s run.',
  "- cypress_list_specs lists specs (titles: true for test names). Fix the cause in the app or the test; a test that passes only on retry is still broken.",
  "- cypress_doctor checks the setup and starts Cypress (about 15 s): use it when a run cannot start, not at every session.",
].join("\n");

export function createServer(
  ctx: ToolContext,
  caps: ReadonlySet<Capability> = new Set(),
): McpServer {
  const server = new McpServer(
    { name: "cypress-mcp", title: "Cypress", version: SERVER_VERSION },
    {
      // The tool set is fixed for the life of the process, so no
      // notifications/tools/list_changed is ever sent: do not advertise it.
      capabilities: { tools: { listChanged: false } },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerAllTools(server, ctx, caps);
  return server;
}
