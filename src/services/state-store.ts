// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import type { CypressRunResult } from "../types/results.js";
import type { CypressRunArgs } from "../types/cypress.js";

let nextId = 1;

/** Runs kept for the read tools. Older runs are dropped first. */
export const MAX_STORED_RUNS = 50;

/** The runId value that means "the latest run of this server". */
export const LAST_RUN = "last";

export interface RunRecord {
  readonly runId: string;
  readonly kind: "run_spec" | "run_test";
  readonly spec: string;
  readonly args: CypressRunArgs;
  readonly result: CypressRunResult;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly timestamp: number;
}

/**
 * Runs of this server process, by runId. Several agents (or subagents) can
 * share one server, so tools take the runId their own run returned; "last"
 * stays available as an explicit value for single-agent use.
 */
export class StateStore {
  private readonly runs = new Map<string, RunRecord>();
  private lastRun: RunRecord | null = null;
  private screenshotIndex = new Map<string, string[]>();

  recordRun(
    kind: "run_spec" | "run_test",
    spec: string,
    args: CypressRunArgs,
    result: CypressRunResult,
    stdout: string,
    stderr: string,
  ): RunRecord {
    const record: RunRecord = {
      runId: `run_${nextId++}`,
      kind,
      spec,
      args,
      result,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr.slice(-2000),
      timestamp: Date.now(),
    };

    this.lastRun = record;
    this.runs.set(record.runId, record);
    // Maps iterate in insertion order, so the first key is the oldest run.
    while (this.runs.size > MAX_STORED_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }

    if (result.screenshots.length > 0) {
      this.screenshotIndex.set(spec, [...result.screenshots]);
    } else {
      this.screenshotIndex.delete(spec);
    }

    return record;
  }

  getLastRun(): RunRecord | null {
    return this.lastRun;
  }

  /** A stored run by id, "last" for the latest run, or null when unknown. */
  getRun(runId: string = LAST_RUN): RunRecord | null {
    if (runId === LAST_RUN) {
      return this.lastRun;
    }
    return this.runs.get(runId) ?? null;
  }

  /** Ids of the stored runs, newest first. */
  runIds(): string[] {
    return [...this.runs.keys()].reverse();
  }

  getScreenshots(spec?: string): string[] {
    if (spec) {
      return this.screenshotIndex.get(spec) ?? [];
    }
    return this.lastRun?.result.screenshots.slice() ?? [];
  }

  clear(): void {
    this.lastRun = null;
    this.runs.clear();
    this.screenshotIndex.clear();
    nextId = 1;
  }
}
