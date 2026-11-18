// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

/**
 * Prefix of the event lines that reporter/cypress-mcp-reporter.cjs prints
 * while Cypress runs. Keep in sync with MARKER in that file.
 */
export const REPORTER_MARKER = "@@cypress-mcp@@";

interface ReporterEvent {
  readonly event: "start" | "test" | "pass" | "fail" | "pending";
  readonly total?: number;
  readonly type?: string;
  readonly title?: string;
  readonly fullTitle?: string;
  readonly duration?: number;
  readonly error?: string;
  readonly stack?: string;
}

/** A test, or a failed hook, that finished before the run ended. */
export interface CompletedTest {
  readonly title: string;
  readonly fullTitle: string;
  readonly state: "passed" | "failed" | "pending";
  readonly hook: boolean;
  readonly duration?: number;
  readonly error?: string;
  readonly stack?: string;
}

export interface RunProgress {
  /** Tests finished so far; strictly increases from one notification to the next */
  readonly completed: number;
  readonly total?: number;
  readonly message: string;
}

const STATES = { pass: "passed", fail: "failed", pending: "pending" } as const;

/**
 * Splits Cypress stdout into the reporter's event lines and everything else.
 * Event lines are consumed (they never reach the output parser or the stored
 * tails); the rest is kept verbatim. Chunks may end mid-line.
 */
export class ReporterEventStream {
  readonly completed: CompletedTest[] = [];
  private output = "";
  private partialLine = "";
  private total: number | undefined;
  private running: string | undefined;
  private finishedTests = 0;

  constructor(private readonly onProgress?: (progress: RunProgress) => void) {}

  /** Full title of the test that started and has not finished yet. */
  get runningTest(): string | undefined {
    return this.running;
  }

  push(chunk: string): void {
    const lines = (this.partialLine + chunk).split("\n");
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      this.handleLine(line, "\n");
    }
  }

  /** Flush the last partial line and return stdout without event lines. */
  end(): string {
    if (this.partialLine) {
      this.handleLine(this.partialLine, "");
      this.partialLine = "";
    }
    return this.output;
  }

  private handleLine(line: string, newline: string): void {
    const at = line.indexOf(REPORTER_MARKER);
    if (at === -1) {
      this.output += line + newline;
      return;
    }

    let event: ReporterEvent;
    try {
      event = JSON.parse(line.slice(at + REPORTER_MARKER.length)) as ReporterEvent;
    } catch {
      // Not one of ours after all: keep it as output.
      this.output += line + newline;
      return;
    }

    // Whatever Cypress printed on the same line before the marker stays.
    this.output += line.slice(0, at);
    this.apply(event);
  }

  private apply(event: ReporterEvent): void {
    const fullTitle = event.fullTitle ?? event.title ?? "";

    if (event.event === "start") {
      this.total = typeof event.total === "number" ? event.total : undefined;
      this.notify(
        `Cypress started${this.total === undefined ? "" : `, ${this.total} tests`}`,
      );
      return;
    }

    if (event.event === "test") {
      this.running = fullTitle;
      return;
    }

    const state = STATES[event.event];
    if (!state) {
      return;
    }

    const hook = event.type === "hook";
    this.completed.push({
      title: event.title ?? fullTitle,
      fullTitle,
      state,
      hook,
      ...(event.duration === undefined ? {} : { duration: event.duration }),
      ...(event.error === undefined ? {} : { error: event.error }),
      ...(event.stack === undefined ? {} : { stack: event.stack }),
    });

    if (!hook) {
      if (this.running === fullTitle) {
        this.running = undefined;
      }
      // Failed hooks are not counted, so progress never passes the total.
      this.finishedTests++;
      this.notify(`${state}: ${fullTitle}`);
    }
  }

  private notify(message: string): void {
    this.onProgress?.({
      completed: this.finishedTests,
      ...(this.total === undefined ? {} : { total: this.total }),
      message,
    });
  }
}
