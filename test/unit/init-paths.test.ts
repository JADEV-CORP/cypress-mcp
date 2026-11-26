// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import type * as fs from "node:fs/promises";
import { realpath, readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { initProject } from "../../src/setup/init.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof fs>()),
  realpath: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

it("refuses a config directory resolved outside the project before reading or writing", async () => {
  const root = path.resolve("fixture-project");
  vi.mocked(realpath)
    .mockResolvedValueOnce(root)
    .mockResolvedValueOnce(path.resolve("sibling"));
  const report = await initProject({ root, clients: ["kiro"], projects: ["."] });
  expect(report.files[0]).toMatchObject({ status: "refused", written: false });
  expect(readFile).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});
