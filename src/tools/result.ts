// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// One result shape for every tool. The text block is what the agent reads, in
// compact lines; structuredContent carries the same envelope as data, so every
// tool, error or not, returns { ok, tool, summary, data, nextActions }.
import { z } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import { CypressMcpError, InternalError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { finish } from "../format/compact.js";

export interface Envelope {
  readonly ok: boolean;
  readonly tool: string;
  readonly runId?: string;
  readonly summary: string;
  readonly data: unknown;
  readonly nextActions: readonly string[];
}

/** Read tools: change nothing, touch only local files. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

/**
 * Tools that start Cypress. Not idempotent (each run writes screenshots and
 * may record to Cypress Cloud), not destructive, and open world: the tests
 * drive a browser against whatever the app under test talks to.
 */
export const RUNS_CYPRESS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Output schema shared by the tools, with a tool specific `data`. */
export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    ok: z
      .boolean()
      .describe("false when the tool could not do its job (not when tests fail)"),
    tool: z.string(),
    runId: z.string().optional(),
    summary: z.string(),
    data: z.union([data, errorDataSchema]),
    nextActions: z.array(z.string()),
  });
}

export const errorDataSchema = z.looseObject({
  code: z.string(),
  error: z.string(),
  suggestion: z.string().optional(),
});

export function textResult(
  text: string,
  envelope: Envelope,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Next steps for errors that have one. Nothing here sends the agent to
 * cypress_doctor: it launches Cypress (about 15 s) and does not help with a
 * wrong path or argument.
 */
const NEXT_ACTIONS_BY_CODE: Readonly<Record<string, readonly string[]>> = {
  SPEC_NOT_FOUND: ["cypress_list_specs"],
  SPEC_OUTSIDE_PROJECT: ["cypress_list_specs"],
  // The message says what to change.
  INVALID_ARGUMENT: [],
  TITLE_FILTER_UNAVAILABLE: ["cypress_run without testName to run the whole spec"],
  RECORD_KEY_MISSING: ["set CYPRESS_RECORD_KEY in the MCP client config for cypress-mcp"],
  RUN_NOT_FOUND: ["cypress_run"],
  CYPRESS_NOT_FOUND: ["npm install --save-dev cypress in the project"],
  CONFIG_NOT_FOUND: ["check --cwd points at the folder with cypress.config.*"],
  BROWSER_CHECK_FAILED: ["omit browser to use the project's default browser"],
  CANCELLED: [],
};

function toKnownError(err: unknown, logger?: Logger): CypressMcpError {
  if (err instanceof CypressMcpError) {
    return err;
  }
  // A bug or an environment problem we did not anticipate. The agent gets an
  // isError result it can act on; the stack goes to stderr for the user.
  logger?.error("Unexpected error in tool handler", {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  return new InternalError(err);
}

function errorEnvelope(tool: string, err: CypressMcpError): Envelope {
  return {
    ok: false,
    tool,
    summary: err.message,
    data: err.toJSON(),
    nextActions: [...(NEXT_ACTIONS_BY_CODE[err.code] ?? [])],
  };
}

/** Error result of every tool: one text line plus the envelope. */
export function errorResult(tool: string, err: unknown, logger?: Logger): CallToolResult {
  const known = toKnownError(err, logger);
  const envelope = errorEnvelope(tool, known);
  const lines = [`Error ${known.code}: ${known.message}`];
  if (known.suggestion && envelope.nextActions.length === 0) {
    lines.push(known.suggestion);
  }
  return textResult(finish(lines, envelope.nextActions), envelope, true);
}
