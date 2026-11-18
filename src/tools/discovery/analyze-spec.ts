// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/index.js";
import type { DescribeBlock, SpecAnalysis } from "../../types/results.js";
import { CypressMcpError } from "../../utils/errors.js";
import { parseSpec, type ParsedSuite } from "../../services/spec-parser.js";

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "cypress_analyze_spec",
    "Deep analysis of a single spec file. Extracts describe/it blocks with line numbers, cy.visit URLs, cy.intercept routes, fixtures used, and custom commands called.",
    {
      spec: z.string().describe("Path to the spec file to analyze"),
    },
    async ({ spec }) => {
      try {
        const resolvedSpec = await ctx.specFinder.resolveSpec(spec);
        const config = await ctx.configLoader.load();
        const content = await fs.readFile(
          path.join(config.projectRoot, resolvedSpec),
          "utf-8",
        );
        const analysis = analyzeSpec(resolvedSpec, content);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(analysis, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  err instanceof CypressMcpError
                    ? err.message
                    : `Could not read spec file: ${spec}`,
                suggestion:
                  "Check the file path. Use cypress_list_specs to see available specs.",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

function analyzeSpec(file: string, content: string): SpecAnalysis {
  return {
    file,
    structure: { describes: toDescribeBlocks(parseSpec(content).root) },
    visits: extractPatterns(content, /cy\.visit\s*\(\s*['"`](.+?)['"`]/g),
    intercepts: extractInterceptPatterns(content),
    fixtures: extractPatterns(content, /cy\.fixture\s*\(\s*['"`](.+?)['"`]/g),
    customCommands: extractCustomCommands(content),
  };
}

/** Top-level suites, preceded by a "(root)" block for tests and hooks outside any describe. */
function toDescribeBlocks(root: ParsedSuite): DescribeBlock[] {
  const blocks = root.suites.map(toDescribeBlock);
  if (root.tests.length > 0 || root.hooks.length > 0) {
    blocks.unshift({ ...toDescribeBlock(root), name: "(root)", nested: [] });
  }
  return blocks;
}

function toDescribeBlock(suite: ParsedSuite): DescribeBlock {
  return {
    name: suite.name,
    ...(suite.line > 0 ? { line: suite.line } : {}),
    ...(suite.mode ? { mode: suite.mode } : {}),
    tests: suite.tests.map((test) => ({
      name: test.name,
      line: test.line,
      ...(test.mode ? { mode: test.mode } : {}),
    })),
    hooks: [...suite.hooks],
    nested: suite.suites.map(toDescribeBlock),
  };
}

function extractPatterns(content: string, regex: RegExp): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      results.push(match[1]);
    }
  }
  return [...new Set(results)];
}

function extractInterceptPatterns(content: string): string[] {
  const results: string[] = [];
  const regex =
    /cy\.intercept\s*\(\s*['"`]?(GET|POST|PUT|DELETE|PATCH)['"`]?\s*,\s*['"`](.+?)['"`]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1] && match[2]) {
      results.push(`${match[1]} ${match[2]}`);
    }
  }
  return [...new Set(results)];
}

function extractCustomCommands(content: string): string[] {
  const results: string[] = [];
  const regex = /cy\.(\w+)\s*\(/g;

  // Standard Cypress commands to exclude
  const builtins = new Set([
    "get",
    "find",
    "contains",
    "click",
    "type",
    "visit",
    "intercept",
    "request",
    "wait",
    "fixture",
    "wrap",
    "should",
    "then",
    "and",
    "its",
    "invoke",
    "within",
    "as",
    "trigger",
    "select",
    "check",
    "uncheck",
    "clear",
    "submit",
    "focus",
    "blur",
    "scrollTo",
    "scrollIntoView",
    "dblclick",
    "rightclick",
    "hover",
    "reload",
    "go",
    "back",
    "forward",
    "viewport",
    "window",
    "document",
    "title",
    "url",
    "hash",
    "location",
    "readFile",
    "writeFile",
    "task",
    "log",
    "pause",
    "debug",
    "screenshot",
    "clock",
    "tick",
    "stub",
    "spy",
    "mount",
    "on",
    "once",
    "off",
    "getCookie",
    "getCookies",
    "setCookie",
    "clearCookie",
    "clearCookies",
    "getAllLocalStorage",
    "clearAllLocalStorage",
    "getAllSessionStorage",
    "clearAllSessionStorage",
    "session",
    "origin",
  ]);

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1] && !builtins.has(match[1])) {
      results.push(`cy.${match[1]}`);
    }
  }

  return [...new Set(results)];
}
