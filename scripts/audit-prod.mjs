// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
//
// Production dependency audit for CI. Same gate as
// `npm audit --omit=dev --audit-level=moderate`, except that advisories listed
// in audit-allowlist.json are skipped until their `until` date. An expired
// entry fails the gate, so nothing stays ignored by accident.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FAILING = new Set(["moderate", "high", "critical"]);
const today = new Date().toISOString().slice(0, 10);

const allowlist = JSON.parse(
  readFileSync(new URL("../audit-allowlist.json", import.meta.url)),
);
const allowed = new Map();
let failed = false;
for (const entry of allowlist) {
  if (entry.until < today) {
    console.error(`Allowlist entry ${entry.id} expired on ${entry.until}: review it.`);
    failed = true;
  } else {
    allowed.set(entry.id, entry);
  }
}

let raw;
try {
  raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
} catch (err) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  raw = err.stdout;
}
const report = JSON.parse(raw);

const seen = new Set();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    // String entries point at another package whose advisory is listed on its own.
    if (typeof via === "string" || !FAILING.has(via.severity)) continue;
    const id = via.url.split("/").pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (allowed.has(id)) {
      console.log(`allowed  ${id} ${via.name}: ${allowed.get(id).reason}`);
    } else {
      console.error(`FAIL     ${id} ${via.severity} ${via.name}: ${via.title}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("Production audit passed.");
