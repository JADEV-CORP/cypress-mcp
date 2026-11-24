// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
const DIAGNOSTIC_PATTERN =
  /(your configfile is invalid|configfile is invalid|error \[err_|cannot find module|cannot find|syntaxerror|referenceerror|typeerror|exception|failed)/i;

const CONFIG_INVALID_PATTERN =
  /(your configfile is invalid|configfile is invalid|it threw an error when required|error \[err_|cannot find module)/i;

const MISSING_SPEC_PATTERN =
  /(no spec files were found|a spec file was requested but not found|we searched for specs matching)/i;

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * What the Cypress CLI prints, before any command, when the npm package is
 * installed but the binary of its version is not in the cache.
 */
const MISSING_BINARY_PATTERN = /No version of Cypress is installed in:?\s*(\S.*)$/m;
const CYPRESS_VERSION_PATTERN = /^Cypress Version:\s*(\S+)/m;

/** The step that installs the binary for the project's Cypress version. */
export const INSTALL_BINARY = "npx cypress install";

/**
 * MCP clients start the server with an environment of their own, which may
 * lack the CYPRESS_CACHE_FOLDER of the user's shell: Cypress then looks in
 * the default cache, and installing again from the shell does not help.
 */
export const CACHE_FOLDER_NOTE =
  "MCP clients may not pass CYPRESS_CACHE_FOLDER to the server, so set it in the client's env for this server if the binary lives elsewhere";

/** The folder Cypress looked for its binary in, when the output says it is missing. */
export function missingBinaryDir(output: string): string | undefined {
  return MISSING_BINARY_PATTERN.exec(output.replace(ANSI_PATTERN, ""))?.[1]?.trim();
}

/** The doctor's line for a missing binary. */
export function binaryNotInstalled(dir: string, version: string | undefined): string {
  const cypress = version ? `Cypress ${version}` : "Cypress";
  return `${cypress} binary not installed in ${dir}. Run: ${INSTALL_BINARY}. ${CACHE_FOLDER_NOTE}.`;
}

/** Cypress prints this when the preprocessor cannot bundle a spec. */
const COMPILE_ERROR_HEADER = "Oops...we found an error preparing this test file:";

/** Where the useful part of the compile error block ends. */
const COMPILE_ERROR_END = [
  /^\s+at\s/, // stack frames inside the Cypress binary
  /^This occurred while Cypress was compiling/,
  /^\s*\(Results\)/,
];

const MAX_COMPILE_ERROR_LINES = 40;

export interface RuntimeCheckResult {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

export function extractDiagnosticSnippet(stdout: string, stderr: string): string {
  const stderrSnippet = findDiagnosticWindow(stderr);
  if (stderrSnippet) {
    return stderrSnippet;
  }

  const stdoutSnippet = findDiagnosticWindow(stdout);
  if (stdoutSnippet) {
    return stdoutSnippet;
  }

  const fallback = stderr.trim() || stdout.trim();
  return trimSnippet(fallback);
}

/**
 * The cause of a spec that failed to compile, as Cypress prints it: the spec
 * path and the bundler's message ("Module not found: Error: Can't resolve
 * './x'", a TypeScript or syntax error with its code frame). Stack frames of
 * the Cypress binary and the generic advice after them are left out. Returns
 * undefined when the output has no compile error block.
 */
export function extractCompileError(stdout: string, stderr: string): string | undefined {
  const output = `${stdout}\n${stderr}`.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n");
  const start = output.indexOf(COMPILE_ERROR_HEADER);
  if (start === -1) {
    return undefined;
  }

  const kept: string[] = [];
  for (const line of output.slice(start).split("\n")) {
    if (COMPILE_ERROR_END.some((pattern) => pattern.test(line))) {
      break;
    }
    if (line.trim() === "" || line.trim() === "The error was:") {
      continue;
    }
    kept.push(line.trimEnd());
    if (kept.length >= MAX_COMPILE_ERROR_LINES) {
      break;
    }
  }

  return trimSnippet(kept.join("\n"));
}

export function classifyConfigRuntimeCheck(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): RuntimeCheckResult {
  const combined = `${stderr}\n${stdout}`;

  const binaryDir = missingBinaryDir(combined);
  if (binaryDir) {
    return {
      status: "fail",
      detail: binaryNotInstalled(binaryDir, CYPRESS_VERSION_PATTERN.exec(combined)?.[1]),
    };
  }

  if (CONFIG_INVALID_PATTERN.test(combined)) {
    return {
      status: "fail",
      detail: extractDiagnosticSnippet(stdout, stderr),
    };
  }

  if (exitCode === 0 || MISSING_SPEC_PATTERN.test(combined)) {
    return {
      status: "ok",
      detail: "Cypress was able to load the config file.",
    };
  }

  return {
    status: "warn",
    detail: extractDiagnosticSnippet(stdout, stderr),
  };
}

const NOISE_PATTERN = /^(DevTools listening|Opening [`']\/dev\/tty|tput:|={3,}|\s*$)/;

function findDiagnosticWindow(output: string): string | null {
  const lines = output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  const lineIndex = lines.findIndex((line) => DIAGNOSTIC_PATTERN.test(line));
  if (lineIndex === -1) {
    return null;
  }

  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(lines.length, lineIndex + 6);
  const window = lines
    .slice(start, end)
    .filter((line) => line.length > 0 && !NOISE_PATTERN.test(line))
    .join("\n");

  return trimSnippet(window);
}

function trimSnippet(value: string): string {
  if (value.length <= 2000) {
    return value;
  }

  return value.slice(0, 2000);
}
