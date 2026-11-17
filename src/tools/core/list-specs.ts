// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/index.js";
import { assertPlainGlob } from "../../services/spec-finder.js";
import { toolError } from "./execute-run.js";

const TOOL = "cypress_list_specs";

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    TOOL,
    "List all Cypress spec files in the project. Returns file paths and test counts.",
    { pattern: z.string().optional().describe("Glob pattern to filter specs") },
    async ({ pattern }) => {
      try {
        // Only the caller's pattern is checked; the project's own specPattern is trusted.
        if (pattern !== undefined) assertPlainGlob(pattern);
        const config = await ctx.configLoader.load();
        const specs = await ctx.specFinder.findSpecs(pattern ?? config.specPattern);
        const results = await Promise.all(
          specs.map(async (file) => ({
            file,
            tests: await ctx.specFinder.countTests(file),
          })),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ specs: results, total: results.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        return toolError(TOOL, err);
      }
    },
  );
}
