// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../../types/index.js";
import { assertPlainGlob } from "../../services/spec-finder.js";
import { finish } from "../../format/compact.js";
import { READ_ONLY, envelopeSchema, errorResult, textResult } from "../result.js";

const TOOL = "cypress_list_specs";

const listDataSchema = z.object({
  pattern: z.array(z.string()),
  total: z.number().describe("Number of specs"),
  totalTests: z.number(),
  specs: z.array(
    z.object({
      file: z.string(),
      tests: z.number(),
      titles: z.array(z.string()).optional(),
    }),
  ),
});

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL,
    {
      title: "List Cypress specs",
      description:
        "List the project's spec files with their test counts, read statically (nothing runs). titles: true adds each test's full title, the text cypress_run's testName matches.",
      inputSchema: z.object({
        pattern: z
          .string()
          .optional()
          .describe(
            "Glob relative to the project root. Default: the project's specPattern",
          ),
        titles: z.boolean().optional().describe("Include test titles"),
      }),
      outputSchema: envelopeSchema(listDataSchema),
      annotations: READ_ONLY,
    },
    async ({ pattern, titles }) => {
      try {
        // Only the caller's pattern is checked; the project's own specPattern is trusted.
        if (pattern !== undefined) assertPlainGlob(pattern);
        const config = await ctx.configLoader.load();
        const patterns = pattern === undefined ? [...config.specPattern] : [pattern];
        const files = await ctx.specFinder.findSpecs(patterns);
        const specs = await Promise.all(
          files.map(async (file) => {
            const parsed = await ctx.specFinder.parse(file);
            const tests = parsed?.tests ?? [];
            return {
              file,
              tests: tests.length,
              ...(titles ? { titles: tests.map((test) => test.fullTitle) } : {}),
            };
          }),
        );
        const totalTests = specs.reduce((sum, spec) => sum + spec.tests, 0);

        const summary = `${specs.length} spec(s), ${totalTests} test(s) matching ${patterns.join(", ")}`;
        const lines = [summary];
        for (const spec of specs) {
          lines.push(`${spec.file}: ${spec.tests}`);
          for (const title of spec.titles ?? []) {
            lines.push(`  ${title}`);
          }
        }
        const nextActions =
          specs.length === 0
            ? ["check the pattern, or the specPattern in the Cypress config"]
            : [];

        return textResult(finish(lines, nextActions), {
          ok: true,
          tool: TOOL,
          summary,
          data: { pattern: patterns, total: specs.length, totalTests, specs },
          nextActions,
        });
      } catch (err) {
        return errorResult(TOOL, err, ctx.logger);
      }
    },
  );
}
