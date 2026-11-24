// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// The default MCP tools from a shell, with the same compact output: `run` is
// cypress_run, `doctor` cypress_doctor, `list` cypress_list_specs. Agents
// that have a shell often prefer a command to an MCP server, and CI logs read
// the same way. `init` is for people: it writes the MCP client config.
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createToolContext } from "./context.js";
import { SERVER_VERSION } from "./server.js";
import { executeCypressRun, type RunOutcome } from "./services/run-executor.js";
import { buildFailureContexts } from "./services/failure-context.js";
import { prepareRun } from "./tools/run-shared.js";
import { abortAllRuns } from "./services/process-manager.js";
import { EXCERPT_RADIUS, runResult, type RunData } from "./tools/run.js";
import { doctorResult } from "./tools/project/doctor.js";
import { listSpecsResult } from "./tools/core/list-specs.js";
import {
  detectClients,
  OUTSIDE_CLIENTS,
  parseClients,
  PROJECT_CLIENTS,
  type ClientId,
} from "./setup/clients.js";
import { findProjects, formatInitReport, initProject } from "./setup/init.js";
import type { ToolContext } from "./types/index.js";
import { CypressMcpError } from "./utils/errors.js";
import { createLogger } from "./utils/logger.js";

export const CLI_USAGE = `Usage: cypress-mcp <command> [options]

Commands:
  run [<spec>...]     run specs in one Cypress launch, print each failure
  doctor              check the Cypress setup
  list                list the specs and their test counts
  init                write the MCP client config for this project

cypress-mcp run [<spec>...] [options]
Runs Cypress once for the given specs, or for every spec when none is given,
and prints per failure the file:line, the error, the screenshot and what the
page showed. A spec can be a path, path:line for the test at that line, or a
glob in quotes. Passing tests are omitted unless --verbose.
  --test <name>       run only tests whose full title contains <name>
  --repeat <n>        run the selected tests n times (1 to 50), to prove a flaky fix
  --component         component tests (cypress run --component)
  --verbose           list passing and pending tests too
  --browser <name>    browser from \`cypress info\` (default: the project's)
  --headed            show the browser
  --timeout <ms>      run timeout in ms (default 300000)
  --env <key=value>   Cypress env value, repeatable

cypress-mcp doctor [--quick] [options]
Checks the config, the Cypress install, the specs and the support file.
Starts Cypress once to load the config (about 15 s) unless --quick.

cypress-mcp list [--titles] [--pattern <glob>] [options]
Lists the spec files and their test counts without running anything.
--titles adds each test's full title, the text --test matches. --pattern is
a glob relative to the project (default: the project's specPattern).

Options of run, doctor and list:
  --project <dir>     monorepos: the folder with cypress.config.*
  --json              print the full result as JSON
  --cwd <dir>         Cypress project root (default: the current directory)

cypress-mcp init [--client <name>] [options]
Adds the cypress server to the project's MCP client config files, keeping
what else they hold, with the paths and timeouts each client needs. Without
--client: the clients whose files are in the project (.mcp.json, .claude,
.vscode, .cursor, .gemini, .junie, .devin, .codex), else .mcp.json for
Claude Code. In a terminal it asks first.
  --client <name>     claude, vscode, vscode-legacy, cursor, gemini, junie,
                      devin, codex; printed, not written: claude-desktop,
                      zed, jetbrains, copilot-cloud. Repeatable or a comma list
  --force             replace a cypress entry that differs
  --dry-run           print what would be written, write nothing
  --yes, -y           do not ask
  --json              print a summary as JSON
  --cwd <dir>         the project folder (default: the current directory)

Exit code: 0 passed, healthy, listed or set up; 1 a test failed or the run
did not complete (run), a check failed (doctor), an entry differs or a file
could not be edited safely (init); 2 bad arguments or setup error (spec,
project or Cypress not found).

Without a command, cypress-mcp is the MCP server on stdio, started by an MCP
client:
  cypress-mcp [--cwd <dir>] [--caps analyze,config|all] [--verbose]`;

/** Printed instead of starting the server when a person runs it in a terminal. */
const SERVER_NOTE = `cypress-mcp is an MCP server: an MCP client (Claude Code, Cursor, VS Code...)
starts it and talks to it over stdin. To add it to a client, run cypress-mcp
init in the project, or see https://github.com/jams4code/cypress-mcp#setup

From a terminal, use a command:
  cypress-mcp init            write the MCP client config for this project
  cypress-mcp run [<spec>...] run specs (default: all) and print each failure
  cypress-mcp doctor          check the Cypress setup
  cypress-mcp list            list the specs
  cypress-mcp --help          every option`;

export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
  /** stdin is a terminal: a person started the process. MCP clients pipe it. */
  readonly interactive: boolean;
  /** Asks a person a question in the terminal and resolves with the answer */
  readonly ask?: (question: string) => Promise<string>;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  cwd: process.cwd(),
  interactive: isatty(0),
  ask: async (question) => {
    // On stderr, so stdout keeps only the report.
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await prompt.question(question);
    } finally {
      prompt.close();
    }
  },
};

type Command = (argv: readonly string[], io: CliIo) => Promise<number>;

/** Options every command takes. */
const COMMON_OPTIONS = {
  project: { type: "string" },
  verbose: { type: "boolean" },
  json: { type: "boolean" },
  cwd: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

/**
 * Runs the command argv names and resolves with its exit code, or with
 * undefined when argv is for the MCP server (no command, only server flags).
 */
export async function runCommand(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number | undefined> {
  const [command] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    io.out(CLI_USAGE);
    return EXIT_PASSED;
  }
  if (command === "--version" || command === "-V") {
    io.out(SERVER_VERSION);
    return EXIT_PASSED;
  }
  const handler = command === undefined ? undefined : COMMANDS.get(command);
  if (handler) {
    return handler(argv.slice(1), io);
  }
  // A typo or a command that does not exist would otherwise start the server
  // and wait silently on stdin.
  if (command !== undefined && !command.startsWith("-")) {
    io.err(`Unknown command: ${command}\n\n${CLI_USAGE}`);
    return EXIT_USAGE;
  }
  if (io.interactive) {
    io.err(SERVER_NOTE);
    return EXIT_USAGE;
  }
  return undefined;
}

/** `cypress-mcp run`: exit 0 when every test passed, 1 when not. */
async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv, io, true, {
    ...COMMON_OPTIONS,
    test: { type: "string" },
    repeat: { type: "string" },
    component: { type: "boolean" },
    browser: { type: "string" },
    headed: { type: "boolean" },
    timeout: { type: "string" },
    env: { type: "string", multiple: true },
  });
  if (!parsed) {
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.out(CLI_USAGE);
    return EXIT_PASSED;
  }
  const repeat = values.repeat === undefined ? undefined : Number(values.repeat);
  if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1 || repeat > 50)) {
    io.err(`--repeat must be a whole number from 1 to 50: ${values.repeat}`);
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

  const ctx = contextFor(io, values);
  const { serverRoot } = ctx;

  // Shell semantics first: a path relative to where the command runs, made
  // relative to the root. Otherwise (globs, path:line, paths under --cwd) as
  // given, the way the MCP tool reads them.
  const specs = positionals.map((arg) => {
    const fromShell = path.resolve(io.cwd, arg);
    if (io.cwd !== serverRoot && existsSync(fromShell)) {
      const relative = path.relative(serverRoot, fromShell);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join("/");
      }
    }
    return arg;
  });

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const run = await prepareRun(ctx, {
      // No spec: every spec of the project.
      spec: specs.length > 0 ? specs : undefined,
      testName: values.test,
      repeat,
      component: values.component,
      project: values.project,
      browser: values.browser,
      headed: values.headed,
      timeout,
      env: Object.keys(env).length > 0 ? env : undefined,
    });
    const outcome = await executeCypressRun(run.ctx, {
      kind: run.args.grep || run.args.titles ? "run_test" : "run_spec",
      specs: run.specs,
      prefix: run.prefix,
      args: run.args,
      notes: run.notes,
      signal: controller.signal,
    });
    const result = await runResult(ctx, outcome, {
      verbose: values.verbose === true,
      cli: true,
    });
    if (values.json) {
      io.out(
        JSON.stringify(await withSource(outcome, result.structuredContent), null, 2),
      );
    } else {
      print(io, result, false);
    }
    return result.structuredContent.data.status === "passed" ? EXIT_PASSED : EXIT_FAILED;
  } catch (err) {
    return setupError(io, err);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await abortAllRuns();
  }
}

/** `cypress-mcp doctor`: exit 0 when healthy, 1 when a check failed. */
async function doctorCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv, io, false, {
    ...COMMON_OPTIONS,
    quick: { type: "boolean" },
  });
  if (!parsed) {
    return EXIT_USAGE;
  }
  const { values } = parsed;
  if (values.help) {
    io.out(CLI_USAGE);
    return EXIT_PASSED;
  }

  try {
    const result = await doctorResult(
      contextFor(io, values),
      { quick: values.quick, project: values.project },
      true,
    );
    print(io, result, values.json);
    return result.structuredContent.data.healthy ? EXIT_PASSED : EXIT_FAILED;
  } catch (err) {
    return setupError(io, err);
  } finally {
    // The full check starts Cypress; never leave it running.
    await abortAllRuns();
  }
}

/** `cypress-mcp list`: exit 0, or 2 when the project or pattern is wrong. */
async function listCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv, io, false, {
    ...COMMON_OPTIONS,
    titles: { type: "boolean" },
    pattern: { type: "string" },
  });
  if (!parsed) {
    return EXIT_USAGE;
  }
  const { values } = parsed;
  if (values.help) {
    io.out(CLI_USAGE);
    return EXIT_PASSED;
  }

  try {
    const result = await listSpecsResult(
      contextFor(io, values),
      { pattern: values.pattern, titles: values.titles, project: values.project },
      true,
    );
    print(io, result, values.json);
    return EXIT_PASSED;
  } catch (err) {
    return setupError(io, err);
  }
}

/**
 * `cypress-mcp init`: exit 0 when every file is written or up to date, 1
 * when an entry differs or a file cannot be edited safely, 2 on bad
 * arguments or no project.
 */
async function initCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv, io, false, {
    cwd: { type: "string" },
    client: { type: "string", multiple: true },
    force: { type: "boolean" },
    "dry-run": { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  if (!parsed) {
    return EXIT_USAGE;
  }
  const { values } = parsed;
  if (values.help) {
    io.out(CLI_USAGE);
    return EXIT_PASSED;
  }

  // Bad names are bad arguments: reported before looking for the project.
  const given = values.client === undefined ? undefined : clientsFrom(values.client, io);
  if (given === null) {
    return EXIT_USAGE;
  }
  const root = path.resolve(io.cwd, values.cwd ?? ".");
  try {
    // The project first: no question is worth asking without one.
    const { projects } = await findProjects(root);
    // --json output is for scripts, which cannot answer.
    const clients = given ?? (await foundClients(root, io, !values.yes && !values.json));
    if (clients === null) {
      return EXIT_USAGE;
    }
    const report = await initProject({
      root,
      projects,
      clients,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
    });
    io.out(values.json ? JSON.stringify(report, null, 2) : formatInitReport(report));
    return report.ok ? EXIT_PASSED : EXIT_FAILED;
  } catch (err) {
    // Worded for init already: CLI_SUGGESTIONS speak of other commands.
    if (!(err instanceof CypressMcpError)) {
      throw err;
    }
    io.err(
      `Error ${err.code}: ${err.message}${err.suggestion ? `\n${err.suggestion}` : ""}`,
    );
    return EXIT_USAGE;
  }
}

/**
 * The clients the project uses, which a person in a terminal may change when
 * `mayAsk`; null after printing why there are none.
 */
async function foundClients(
  root: string,
  io: CliIo,
  mayAsk: boolean,
): Promise<ClientId[] | null> {
  const found = detectClients(root);
  if (!mayAsk || !io.interactive || !io.ask) {
    return found;
  }
  // Ctrl+C or Ctrl+D at the prompt rejects: the person changed their mind.
  const answer = await io.ask(clientQuestion(found)).catch(() => undefined);
  if (answer === undefined) {
    io.err("Cancelled: nothing is written.");
    return null;
  }
  return clientsFrom([answer], io, found);
}

/** Client names from --client or an answer, `empty` for none; null after printing what is wrong. */
function clientsFrom(
  values: readonly string[],
  io: CliIo,
  empty?: ClientId[],
): ClientId[] | null {
  const { clients, unknown } = parseClients(values);
  if (unknown.length > 0) {
    io.err(
      `Unknown client: ${unknown.join(", ")}. Known: ${[...PROJECT_CLIENTS, ...OUTSIDE_CLIENTS].join(", ")}.`,
    );
    return null;
  }
  if (clients.length > 0) {
    return clients;
  }
  if (empty) {
    return empty;
  }
  io.err("--client needs a client name, for example --client cursor");
  return null;
}

function clientQuestion(found: readonly ClientId[]): string {
  return `Set up cypress-mcp for which MCP clients?
  written in the project: ${PROJECT_CLIENTS.join(", ")}
  printed, not written:   ${OUTSIDE_CLIENTS.join(", ")}
Comma list, Enter for ${found.join(", ")}: `;
}

const COMMANDS: ReadonlyMap<string, Command> = new Map([
  ["run", runCli],
  ["doctor", doctorCli],
  ["list", listCli],
  ["init", initCli],
]);

/** Parsed arguments, or undefined after printing what is wrong with them. */
function parse<T extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  io: CliIo,
  allowPositionals: boolean,
  options: T,
) {
  try {
    return parseArgs({ args: [...argv], options, allowPositionals, strict: true });
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n\n${CLI_USAGE}`);
    return undefined;
  }
}

/** Services for the project at --cwd. Info logs stay off: stderr reaches the agent too. */
function contextFor(io: CliIo, values: { cwd?: string; verbose?: boolean }): ToolContext {
  const serverRoot = path.resolve(io.cwd, values.cwd ?? ".");
  return createToolContext(serverRoot, createLogger(values.verbose === true, true));
}

/** The text an agent reads, or with --json the whole envelope. */
function print(io: CliIo, result: CallToolResult, json: boolean | undefined): void {
  if (json) {
    io.out(JSON.stringify(result.structuredContent, null, 2));
  } else {
    const [text] = result.content;
    io.out(text?.type === "text" ? text.text : "");
  }
}

/**
 * The run envelope with each failure's source excerpt and stack. An MCP
 * client asks cypress_get_failure for them later; a CLI process keeps no runs.
 */
async function withSource(
  outcome: RunOutcome,
  envelope: { data: RunData },
): Promise<{ data: RunData }> {
  const { record } = outcome;
  const contexts = await buildFailureContexts(record, record.projectRoot, EXCERPT_RADIUS);
  const failures = envelope.data.failures.map((failure) => {
    const context = contexts[failure.index - 1];
    return {
      ...failure,
      ...(context?.excerpt ? { excerpt: context.excerpt } : {}),
      ...(context?.stack ? { stack: context.stack } : {}),
    };
  });
  return { ...envelope, data: { ...envelope.data, failures } };
}

/** Suggestions that name an MCP tool or argument, worded for the CLI. */
const CLI_SUGGESTIONS: Readonly<Record<string, string>> = {
  SPEC_NOT_FOUND: "Check the path. cypress-mcp list shows the specs.",
  SPEC_OUTSIDE_PROJECT:
    "Pass a spec path inside the project. cypress-mcp list shows the specs.",
  CYPRESS_NOT_FOUND:
    "Install Cypress in the project with 'npm install --save-dev cypress', then run cypress-mcp doctor.",
  CONFIG_NOT_FOUND:
    "Run it in the folder that holds cypress.config.*, or pass --cwd with that folder.",
  PROJECT_REQUIRED: "Pass --project with one of the folders listed.",
  BROWSER_CHECK_FAILED:
    "Omit --browser to use the project's default browser, or run cypress-mcp doctor.",
  TITLE_FILTER_UNAVAILABLE:
    "Run without --test for the whole spec, or wire @cypress/grep into the project.",
  INVALID_ARGUMENT: "Fix the argument and run the command again.",
};

/** Exit code for an error the user can fix; anything else is a bug and propagates. */
function setupError(io: CliIo, err: unknown): number {
  if (!(err instanceof CypressMcpError)) {
    throw err;
  }
  const suggestion = CLI_SUGGESTIONS[err.code] ?? err.suggestion;
  io.err(`Error ${err.code}: ${err.message}${suggestion ? `\n${suggestion}` : ""}`);
  return err.code === "CANCELLED" ? EXIT_FAILED : EXIT_USAGE;
}
