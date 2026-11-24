// scripts/audit-prod.mjs, the CI gate on advisories for the bundled packages,
// run with a stand-in npm first on PATH so no registry is reached. Needs
// `npm run build` first: the script reads the build's metafile.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/audit-prod.mjs");

/** What npm 11 prints for `npm audit --json` when the registry is unreachable. */
const UNREACHABLE = {
  message:
    "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
  error: { summary: "", detail: "" },
};

const CLEAN = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: {
      prod: 1,
      dev: 270,
      optional: 0,
      peer: 0,
      peerOptional: 0,
      total: 270,
    },
  },
};

let bin: string;

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-npm-"));
  // The script runs `npm` directly, or through cmd.exe on Windows.
  fs.writeFileSync(
    path.join(bin, "npm"),
    '#!/bin/sh\ncat "$(dirname "$0")/report.json"\nexit 1\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "npm.cmd"),
    '@echo off\r\ntype "%~dp0report.json"\r\nexit /b 1\r\n',
  );
});

afterAll(() => {
  fs.rmSync(bin, { recursive: true, force: true });
});

function audit(report: object): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  fs.writeFileSync(path.join(bin, "report.json"), JSON.stringify(report));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    env[key] = /^path$/i.test(key) ? `${bin}${path.delimiter}${value}` : value;
  }
  const result = spawnSync(process.execPath, [SCRIPT], {
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("audit-prod.mjs", () => {
  it("fails when npm audit could not reach the registry", () => {
    const { status, stdout, stderr } = audit(UNREACHABLE);
    expect(stdout).not.toContain("passed");
    expect(stderr).toContain(`npm audit failed: ${UNREACHABLE.message}`);
    expect(status).toBe(1);
  });

  it("passes a report with no advisory", () => {
    const { status, stdout } = audit(CLEAN);
    expect(stdout).toContain("Audit of the bundled packages passed.");
    expect(status).toBe(0);
  });
});
