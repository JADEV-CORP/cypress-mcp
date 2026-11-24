// The cypress_run arguments as the SDK validates them, and the Cloud options
// on their way to the `cypress run` arguments.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runInputSchema } from "../../src/tools/run.js";
import { prepareRun, toCloudArgs } from "../../src/tools/run-shared.js";
import type { ToolContext } from "../../src/types/index.js";

/** Issue messages as the MCP SDK joins them into the tool error. */
async function rejection(args: unknown): Promise<string> {
  const result = await runInputSchema["~standard"].validate(args);
  expect(result.issues, JSON.stringify(args)).toBeDefined();
  return (result.issues ?? [])
    .map((issue) =>
      issue.path?.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join(", ");
}

describe("cypress_run input schema", () => {
  it("takes the Cloud options in one cloud object", () => {
    const parsed = runInputSchema.parse({
      spec: "cypress/e2e/a.cy.ts",
      cloud: { record: true, tags: ["nightly"], group: "smoke", ciBuildId: "b-7" },
    });
    expect(parsed.cloud).toEqual({
      record: true,
      tags: ["nightly"],
      group: "smoke",
      ciBuildId: "b-7",
    });
  });

  it("shows the model one cloud property instead of four", () => {
    const schema = z.toJSONSchema(runInputSchema) as {
      properties: Record<string, { description?: string }>;
    };
    const names = Object.keys(schema.properties);
    expect(names).toContain("cloud");
    expect(names).not.toContain("record");
    expect(names).not.toContain("tags");
    expect(names).not.toContain("group");
    expect(names).not.toContain("ciBuildId");
    expect(schema.properties["cloud"]?.description).toContain("CYPRESS_RECORD_KEY");
  });

  it("points 0.4 callers that pass record at the top level to cloud", async () => {
    for (const key of ["record", "tags", "group", "ciBuildId"]) {
      const message = await rejection({ spec: "a.cy.ts", [key]: key === "record" });
      expect(message, key).toContain(`"${key}"`);
      expect(message, key).toContain("cloud: {record: true}");
    }
  });

  it("names every unknown key when a moved one is among them", async () => {
    const message = await rejection({ record: true, specFile: "a.cy.ts" });
    expect(message).toContain('"record", "specFile"');
    expect(message).toContain("cloud: {record: true}");
  });

  it("keeps the plain message for other unknown keys", async () => {
    const message = await rejection({ specFile: "a.cy.ts" });
    expect(message).toContain('"specFile"');
    expect(message).not.toContain("cloud");
  });

  it("rejects unknown keys inside cloud, so a typo does not skip recording", async () => {
    const message = await rejection({ cloud: { recod: true } });
    expect(message).toMatch(/^cloud: .*"recod"/);
  });
});

describe("Cloud options", () => {
  it("become Cypress arguments only with record: true", () => {
    expect(toCloudArgs(undefined)).toBeUndefined();
    expect(toCloudArgs({ tags: ["nightly"] })).toBeUndefined();
    expect(
      toCloudArgs({ record: true, tags: ["nightly"], group: "smoke", ciBuildId: "b-7" }),
    ).toEqual({ record: true, tags: ["nightly"], group: "smoke", ciBuildId: "b-7" });
  });

  it("are checked before the project is looked up", async () => {
    // An empty context: validation must throw before anything touches it.
    const ctx = {} as ToolContext;
    await expect(
      prepareRun(ctx, { cloud: { record: true, tags: ["a,b"] } }),
    ).rejects.toThrow(/cloud\.tags/);
    await expect(
      prepareRun(ctx, { cloud: { record: true, group: " " } }),
    ).rejects.toThrow(/cloud\.group/);
    await expect(
      prepareRun(ctx, { cloud: { ciBuildId: "x".repeat(201) } }),
    ).rejects.toThrow(/cloud\.ciBuildId/);
  });
});
