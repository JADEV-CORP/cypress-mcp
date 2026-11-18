// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/index.js";
import type { SpecSummary } from "../../types/results.js";
import type { ParsedSpec } from "../../services/spec-parser.js";

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "cypress_discover",
    "Discover and map the entire Cypress test suite. Returns all specs with test counts, describe blocks, and test names. Use this first to understand what tests exist before writing or running anything.",
    {},
    async () => {
      const config = await ctx.configLoader.load();
      const specFiles = await ctx.specFinder.findSpecs(config.specPattern);

      const specs: SpecSummary[] = await Promise.all(
        specFiles.map(async (file) => toSummary(file, await ctx.specFinder.parse(file))),
      );

      const totalTests = specs.reduce((sum, s) => sum + s.tests, 0);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                tool: "cypress_discover",
                summary: `Found ${specs.length} spec files with ${totalTests} total tests`,
                data: {
                  projectRoot: config.projectRoot,
                  configFile: config.cypressConfigFile,
                  specCount: specs.length,
                  totalTests,
                  specs,
                },
                nextActions:
                  specs.length > 0
                    ? ["cypress_analyze_spec", "cypress_run_spec"]
                    : ["cypress_doctor"],
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

function toSummary(file: string, parsed: ParsedSpec | null): SpecSummary {
  if (!parsed) {
    return { file, tests: 0, describes: [], testNames: [] };
  }

  return {
    file,
    tests: parsed.tests.length,
    describes: parsed.suites.map((suite) => suite.name),
    testNames: parsed.tests.map((test) => test.name),
  };
}
