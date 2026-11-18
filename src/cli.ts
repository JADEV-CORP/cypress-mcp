// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// `cypress-mcp run <spec>`: the cypress_run tool from a shell, with the same
// compact output. Agents that have a shell often prefer a command to an MCP
// server, and CI logs read the same way.
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createToolContext } from "./context.js";
import { executeCypressRun } from "./services/run-executor.js";
import { buildRunArgs } from "./tools/run-shared.js";
import { runResult } from "./tools/run.js";
import { CypressMcpError } from "./utils/errors.js";
import { createLogger } from "./utils/logger.js";

export const CLI_USAGE = `Usage: cypress-mcp run <spec> [options]

Runs one Cypress spec and prints one line per failure (file:line, error,
screenshot). Passing tests are omitted unless --verbose.

Options:
  --test <name>       run only tests whose title contains <name> (needs @cypress/grep)
  --verbose           list passing and pending tests too
  --browser <name>    browser from \`cypress info\` (default: the project's)
  --headed            show the browser
  --timeout <ms>      run timeout in ms (default 300000)
  --env <key=value>   Cypress env value, repeatable
  --json              print the full result as JSON
  --cwd <dir>         Cypress project root (default: the current directory)

Exit code: 0 all tests passed, 1 a test failed or the run did not complete,
2 bad arguments or setup error (spec or Cypress not found).

Without a command, cypress-mcp starts the MCP server on stdio:
  cypress-mcp [--cwd <dir>] [--caps analyze,config,legacy|all] [--verbose]`;

export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  cwd: process.cwd(),
};

/** Runs `cypress-mcp run ...` and resolves with the exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        test: { type: "string" },
        verbose: { type: "boolean" },
        browser: { type: "string" },
        headed: { type: "boolean" },
        timeout: { type: "string" },
        env: { type: "string", multiple: true },
        json: { type: "boolean" },
        cwd: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n\n${CLI_USAGE}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.out(CLI_USAGE);
    return EXIT_PASSED;
  }
  if (positionals.length !== 1) {
    io.err(`Expected one spec, got ${positionals.length}.\n\n${CLI_USAGE}`);
    return EXIT_USAGE;
  }

  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1_000)) {
    io.err(
      `--timeout must be a whole number of milliseconds, at least 1000: ${values.timeout}`,
    );
    return EXIT_USAGE;
  }

  const env: Record<string, string> = {};
  for (const pair of values.env ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      io.err(`--env takes key=value: ${pair}`);
      return EXIT_USAGE;
    }
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }

  const projectRoot = path.resolve(io.cwd, values.cwd ?? ".");
  const logger = createLogger(values.verbose === true, true);
  const ctx = createToolContext(projectRoot, logger);

  // Shell semantics first: a path relative to where the command runs. Fall
  // back to the project root, the way the MCP tool reads it.
  const specArg = positionals[0]!;
  const fromShell = path.resolve(io.cwd, specArg);
  const spec = existsSync(fromShell) ? fromShell : specArg;

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const { spec: resolvedSpec, args } = await buildRunArgs(ctx, {
      spec,
      testName: values.test,
      browser: values.browser,
      headed: values.headed,
      timeout,
      env: Object.keys(env).length > 0 ? env : undefined,
    });
    const outcome = await executeCypressRun(ctx, {
      kind: args.grep ? "run_test" : "run_spec",
      spec: resolvedSpec,
      args,
      testName: args.grep,
      signal: controller.signal,
    });
    const result = await runResult(ctx, outcome, values.verbose === true);

    if (values.json) {
      io.out(JSON.stringify(result.structuredContent, null, 2));
    } else {
      const [text] = result.content;
      io.out(text?.type === "text" ? text.text : "");
    }
    return result.structuredContent.data.status === "passed" ? EXIT_PASSED : EXIT_FAILED;
  } catch (err) {
    if (err instanceof CypressMcpError) {
      io.err(
        `Error ${err.code}: ${err.message}${err.suggestion ? `\n${err.suggestion}` : ""}`,
      );
      return err.code === "CANCELLED" ? EXIT_FAILED : EXIT_USAGE;
    }
    throw err;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await ctx.processManager.abort();
  }
}
