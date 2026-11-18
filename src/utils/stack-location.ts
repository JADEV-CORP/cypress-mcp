// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

/** `(file:line:col)` at the end of a V8 stack frame, or `at file:line:col`. */
const FRAME_PATTERN = /^\s*at\s+(?:.*?\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Line and column in `spec` where a failure happened, read from the error's
 * stack. Cypress maps stacks back to the original source, so the frame that
 * points into the spec file is the line to show. Frames are matched against
 * the spec path relative to the project root; bundler prefixes such as
 * `webpack://project/./` and `?p=` are ignored. Falls back to a frame in a
 * file with the same base name. Returns undefined when no frame points at the
 * spec, for instance when the failure is in a support file only.
 */
export function findSpecLocation(
  stack: string,
  spec: string,
): SourceLocation | undefined {
  const target = normalize(spec);
  const baseName = path.posix.basename(target);
  let fallback: SourceLocation | undefined;

  for (const line of stack.split("\n")) {
    const match = FRAME_PATTERN.exec(line);
    if (!match) {
      continue;
    }

    const file = normalize(decode(match[1]!));
    const location = { line: Number(match[2]), column: Number(match[3]) };

    if (file === target || file.endsWith(`/${target}`) || file.endsWith(`=${target}`)) {
      return location;
    }

    if (!fallback && (file === baseName || file.endsWith(`/${baseName}`))) {
      fallback = location;
    }
  }

  return fallback;
}

function normalize(file: string): string {
  return file
    .replace(/\\/g, "/")
    .replace(/\/\.\//g, "/")
    .replace(/^\.\//, "");
}

function decode(file: string): string {
  try {
    return decodeURI(file);
  } catch {
    return file;
  }
}

/**
 * Up to `radius` lines either side of `line` (1-based), numbered, with the
 * target line marked `>>>`.
 */
export function excerptAround(
  content: string,
  line: number,
  radius = 5,
): string | undefined {
  const lines = content.split("\n");
  if (line < 1 || line > lines.length) {
    return undefined;
  }

  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  const excerpt: string[] = [];
  for (let current = start; current <= end; current++) {
    const marker = current === line ? " >>>" : "    ";
    excerpt.push(`${marker} ${current}: ${lines[current - 1]!.replace(/\r$/, "")}`);
  }
  return excerpt.join("\n");
}
