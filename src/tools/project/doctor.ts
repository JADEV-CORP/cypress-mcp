// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../../types/index.js";
import { classifyConfigRuntimeCheck } from "../../utils/cypress-diagnostics.js";
import { normalizePath } from "../../utils/paths.js";
import { finish } from "../../format/compact.js";
import { READ_ONLY, envelopeSchema, errorResult, textResult } from "../result.js";

const TOOL = "cypress_doctor";

const SUPPORT_FILES = [
  "cypress/support/e2e.ts",
  "cypress/support/e2e.js",
  "cypress/support/index.ts",
  "cypress/support/index.js",
];

type Status = "ok" | "warn" | "fail";

interface Check {
  check: string;
  status: Status;
  detail: string;
}

const doctorDataSchema = z.object({
  healthy: z.boolean(),
  launched: z.boolean().describe("Whether Cypress was started to check the config"),
  checks: z.array(
    z.object({
      check: z.string(),
      status: z.enum(["ok", "warn", "fail"]),
      detail: z.string(),
    }),
  ),
});

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL,
    {
      title: "Check the Cypress setup",
      description:
        "Check the Cypress setup: config file, Cypress install, specs, support file, grep plugin, Cloud settings. Starts Cypress once to load the config (about 15 s) unless quick is true. Use it when a run cannot start, not before every session.",
      inputSchema: z.object({
        quick: z
          .boolean()
          .optional()
          .describe("Skip starting Cypress; check files and install only"),
      }),
      outputSchema: envelopeSchema(doctorDataSchema),
      annotations: READ_ONLY,
    },
    async ({ quick }) => {
      try {
        const launch = quick !== true;
        const checks = await runChecks(ctx, launch);
        const failed = checks.filter((c) => c.status === "fail").length;
        const warned = checks.filter((c) => c.status === "warn").length;
        const healthy = failed === 0;

        const summary = healthy
          ? `Healthy${warned > 0 ? `, ${warned} warning(s)` : ""}${launch ? "" : " (quick: Cypress not started)"}`
          : `${failed} problem(s) to fix${warned > 0 ? `, ${warned} warning(s)` : ""}`;
        const nextActions = healthy
          ? []
          : ["fix the fail lines above, then call cypress_doctor again"];
        const lines = [
          summary,
          ...checks.map(
            (c) => `${c.status.padEnd(4)} ${c.check}: ${c.detail.replace(/\n+/g, " | ")}`,
          ),
        ];

        return textResult(finish(lines, nextActions), {
          ok: healthy,
          tool: TOOL,
          summary,
          data: { healthy, launched: launch, checks },
          nextActions,
        });
      } catch (err) {
        return errorResult(TOOL, err, ctx.logger);
      }
    },
  );
}

async function runChecks(ctx: ToolContext, launch: boolean): Promise<Check[]> {
  const checks: Check[] = [];

  let config;
  try {
    config = await ctx.configLoader.load();
  } catch (err) {
    checks.push({
      check: "Config file",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
    return checks;
  }
  checks.push({ check: "Config file", status: "ok", detail: config.cypressConfigFile });

  const specs = await ctx.specFinder.findSpecs(config.specPattern);
  checks.push({
    check: "Spec files",
    status: specs.length > 0 ? "ok" : "warn",
    detail:
      specs.length > 0
        ? `${specs.length} spec files found`
        : `No spec files found matching ${config.specPattern.join(", ")}`,
  });

  checks.push(await supportFileCheck(config.projectRoot, config.supportFile));

  let binaryFound = false;
  try {
    const binary = await ctx.processManager.resolveBinary();
    binaryFound = true;
    checks.push({
      check: "Cypress binary",
      status: "ok",
      detail: normalizePath(path.relative(config.projectRoot, binary)),
    });
  } catch {
    checks.push({
      check: "Cypress binary",
      status: "fail",
      detail: "Not found. Run: npm install --save-dev cypress",
    });
  }

  if (!launch) {
    checks.push({
      check: "Config runtime",
      status: "ok",
      detail:
        "Not checked (quick). Call without quick to start Cypress and load the config.",
    });
  } else if (binaryFound) {
    try {
      // A spec that cannot exist: Cypress loads the config, finds no spec and stops.
      const validation = await ctx.processManager.run({
        spec: "__cypress_mcp_config_check__.cy.ts",
        browser: config.defaultBrowser,
        timeout: Math.min(config.defaultTimeout, 30_000),
        configFile: config.cypressConfigFile,
      });
      const runtimeCheck = classifyConfigRuntimeCheck(
        validation.exitCode,
        validation.stdout,
        validation.stderr,
      );
      checks.push({ check: "Config runtime", ...runtimeCheck });
    } catch (err) {
      checks.push({
        check: "Config runtime",
        status: "warn",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    checks.push({
      check: "Config runtime",
      status: "warn",
      detail: "Skipped because the Cypress binary was not found.",
    });
  }

  checks.push({
    check: "Test title filter",
    status: config.titleFilterSupport ? "ok" : "warn",
    detail: config.titleFilterSupport
      ? "Configured: cypress_run accepts testName"
      : "Not configured: cypress_run runs whole specs only. Add @cypress/grep to run one test.",
  });

  checks.push(cloudCheck(config.projectId, Boolean(process.env["CYPRESS_RECORD_KEY"])));

  checks.push(
    await dirCheck("Screenshots dir", config.projectRoot, config.screenshotsDir),
  );
  checks.push(await dirCheck("Downloads dir", config.projectRoot, config.downloadsDir));

  return checks;
}

async function supportFileCheck(
  projectRoot: string,
  supportFile: string | false | undefined,
): Promise<Check> {
  if (supportFile === false) {
    return { check: "Support file", status: "ok", detail: "Disabled by Cypress config" };
  }
  const candidates = typeof supportFile === "string" ? [supportFile] : SUPPORT_FILES;
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(projectRoot, candidate));
      return { check: "Support file", status: "ok", detail: candidate };
    } catch {
      // try the next one
    }
  }
  return {
    check: "Support file",
    status: "warn",
    detail: `Not found (${candidates.join(", ")})`,
  };
}

async function dirCheck(check: string, projectRoot: string, dir: string): Promise<Check> {
  try {
    await fs.access(path.join(projectRoot, dir));
    return { check, status: "ok", detail: normalizePath(dir) };
  } catch {
    // Cypress creates it; nothing for the agent to do, so not a warning.
    return { check, status: "ok", detail: `${dir} (created on first run)` };
  }
}

/** Cloud is optional, so a project without it is healthy. Exported for tests. */
export function cloudCheck(
  projectId: string | undefined,
  hasRecordKey: boolean,
): { check: string; status: "ok" | "warn"; detail: string } {
  const check = "Cypress Cloud";
  if (projectId && hasRecordKey) {
    return { check, status: "ok", detail: `Ready to record (projectId ${projectId})` };
  }
  if (projectId) {
    return {
      check,
      status: "warn",
      detail: `projectId ${projectId} found, but CYPRESS_RECORD_KEY is not set in the server environment, so record: true will fail`,
    };
  }
  if (hasRecordKey) {
    return {
      check,
      status: "warn",
      detail:
        "CYPRESS_RECORD_KEY is set but no projectId was found in the Cypress config",
    };
  }
  return {
    check,
    status: "ok",
    detail: "Not configured (optional, only needed to record runs)",
  };
}
