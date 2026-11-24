import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigLoader } from "../../src/services/config-loader.js";
import { createLogger, type Logger } from "../../src/utils/logger.js";
import type { CypressMcpConfig } from "../../src/types/config.js";

const fixtureRoot = path.resolve("test/fixtures/cypress-project");
const logger = createLogger(false);

describe("ConfigLoader", () => {
  it("should detect cypress.config.ts in fixture project", async () => {
    const loader = new ConfigLoader(fixtureRoot, logger);
    const config = await loader.load();

    expect(config.cypressConfigFile).toBe("cypress.config.ts");
    // No browser unless cypress-mcp.config.json asks for one, so Cypress keeps
    // the project's own default instead of being forced onto Electron.
    expect(config.defaultBrowser).toBeUndefined();
    expect(config.defaultTimeout).toBe(300_000);
    expect(config.specPattern).toEqual(["cypress/e2e/**/*.cy.{ts,js}"]);
    expect(config.supportFile).toBe("cypress/support/e2e.ts");
    expect(config.titleFilterSupport).toBe(false);
    // No cypress-mcp.config.json is fine: nothing to warn about.
    expect(config.serverConfigError).toBeUndefined();
  });

  describe("a cypress-mcp.config.json that cannot be used", () => {
    async function loadWith(
      serverConfig: string,
    ): Promise<{ config: CypressMcpConfig; warnings: Record<string, unknown>[] }> {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-config-"));
      const warnings: Record<string, unknown>[] = [];
      const recording: Logger = {
        ...logger,
        warn: (message, data) => warnings.push({ message, ...data }),
      };
      try {
        await fs.writeFile(
          path.join(tempRoot, "cypress.config.js"),
          "module.exports = { e2e: {} };\n",
        );
        await fs.writeFile(path.join(tempRoot, "cypress-mcp.config.json"), serverConfig);
        const config = await new ConfigLoader(tempRoot, recording).load();
        // The logged path is absolute; keep only the file name to compare.
        return {
          config,
          warnings: warnings.map((w) => ({
            ...w,
            path: path.basename(String(w["path"])),
          })),
        };
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    }

    it("warns with the path and parse error when it is not valid JSON, and keeps defaults", async () => {
      const { config, warnings } = await loadWith(
        '{ "defaultBrowser": "chrome", "defaultTimeout": 1000, }\n',
      );

      expect(config.defaultBrowser).toBeUndefined();
      expect(config.defaultTimeout).toBe(300_000);
      expect(config.failureContext).toBe(true);
      expect(config.serverConfigError).toMatch(
        /^cypress-mcp\.config\.json ignored, defaults apply: .*JSON/,
      );
      expect(warnings).toEqual([
        expect.objectContaining({
          path: "cypress-mcp.config.json",
          error: expect.stringMatching(/JSON/),
        }),
      ]);
    });

    it("warns when it holds something other than an object", async () => {
      const { config } = await loadWith('["chrome"]\n');

      expect(config.serverConfigError).toBe(
        "cypress-mcp.config.json ignored, defaults apply: it must hold a JSON object",
      );
    });
  });

  it("should cache config on repeated loads", async () => {
    const loader = new ConfigLoader(fixtureRoot, logger);
    const config1 = await loader.load();
    const config2 = await loader.load();

    expect(config1).toBe(config2);
  });

  it("should invalidate cache", async () => {
    const loader = new ConfigLoader(fixtureRoot, logger);
    const config1 = await loader.load();
    loader.invalidate();
    const config2 = await loader.load();

    expect(config1).not.toBe(config2);
    expect(config1.cypressConfigFile).toBe(config2.cypressConfigFile);
  });

  it("should throw on missing config", async () => {
    const loader = new ConfigLoader("/nonexistent/path", logger);

    await expect(loader.load()).rejects.toThrow("No Cypress config file found");
  });

  it("should follow simple relative imports for config hints", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-config-"));

    try {
      await fs.mkdir(path.join(tempRoot, "config"), { recursive: true });
      await fs.writeFile(
        path.join(tempRoot, "cypress.config.ts"),
        'import shared from "./config/shared";\nexport default shared;\n',
      );
      await fs.writeFile(
        path.join(tempRoot, "config", "shared.ts"),
        [
          "export default {",
          '  e2e: { specPattern: ["e2e/**/*.cy.ts"], supportFile: false },',
          '  screenshotsFolder: "artifacts/screens",',
          '  downloadsFolder: "artifacts/downloads",',
          "};",
          "",
        ].join("\n"),
      );

      const loader = new ConfigLoader(tempRoot, logger);
      const config = await loader.load();

      expect(config.specPattern).toEqual(["e2e/**/*.cy.ts"]);
      expect(config.supportFile).toBe(false);
      expect(config.screenshotsDir).toBe("artifacts/screens");
      expect(config.downloadsDir).toBe("artifacts/downloads");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  describe("reads e2e options, not the component ones", () => {
    async function load(config: string): Promise<CypressMcpConfig> {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-config-"));
      try {
        await fs.writeFile(path.join(tempRoot, "cypress.config.ts"), config);
        return await new ConfigLoader(tempRoot, logger).load();
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    }

    it("takes specPattern and supportFile from e2e when component comes first", async () => {
      const config = await load(
        [
          'import { defineConfig } from "cypress";',
          "export default defineConfig({",
          "  component: {",
          '    devServer: { framework: "react", bundler: "vite" },',
          '    specPattern: "src/**/*.cy.tsx",',
          '    supportFile: "cypress/support/component.ts",',
          "  },",
          "  e2e: {",
          '    specPattern: ["cypress/e2e/**/*.cy.ts", "cypress/smoke/**/*.cy.ts"],',
          '    supportFile: "cypress/support/e2e.ts",',
          "  },",
          "});",
        ].join("\n"),
      );

      expect(config.specPattern).toEqual([
        "cypress/e2e/**/*.cy.ts",
        "cypress/smoke/**/*.cy.ts",
      ]);
      expect(config.supportFile).toBe("cypress/support/e2e.ts");
    });

    it("keeps a glob with brackets whole inside an array", async () => {
      const config = await load(
        'export default { e2e: { specPattern: ["cypress/e2e/**/*.cy.[jt]s", "more/*.cy.js"] } };\n',
      );

      expect(config.specPattern).toEqual(["cypress/e2e/**/*.cy.[jt]s", "more/*.cy.js"]);
    });

    it("prefers e2e overrides, then top-level values, and skips comments", async () => {
      const config = await load(
        [
          "export default {",
          '  screenshotsFolder: "shots/all",',
          '  downloadsFolder: "downloads/all",',
          '  component: { screenshotsFolder: "shots/component", supportFile: false },',
          "  e2e: {",
          '    // specPattern: "old/**/*.cy.js",',
          '    downloadsFolder: "downloads/e2e",',
          "  },",
          "};",
        ].join("\n"),
      );

      expect(config.screenshotsDir).toBe("shots/all");
      expect(config.downloadsDir).toBe("downloads/e2e");
      expect(config.supportFile).toBeUndefined();
      expect(config.specPattern).toEqual(["cypress/e2e/**/*.cy.{ts,js,tsx,jsx}"]);
    });

    it("finds the end of e2e past code with quotes in regexes and templates", async () => {
      const config = await load(
        [
          "module.exports = {",
          "  e2e: {",
          "    setupNodeEvents(on) {",
          "      on('task', { clean: (s) => s.replace(/['\"{]/g, '') + `}${'{'}` });",
          "    },",
          "  },",
          '  component: { specPattern: "src/**/*.cy.tsx" },',
          "};",
          "const e2e = { specPattern: 'tests/**/*.cy.js' };",
        ].join("\n"),
      );

      expect(config.specPattern).toEqual(["tests/**/*.cy.js"]);
    });

    it("falls back to the default when only component tests set a specPattern", async () => {
      const config = await load(
        "export default { component: { specPattern: 'src/**/*.cy.tsx' }, e2e: {} };\n",
      );

      expect(config.specPattern).toEqual(["cypress/e2e/**/*.cy.{ts,js,tsx,jsx}"]);
    });
  });

  it("should honor server config overrides for config path and title filtering", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-config-"));

    try {
      await fs.mkdir(path.join(tempRoot, "config"), { recursive: true });
      await fs.writeFile(
        path.join(tempRoot, "config", "custom.config.ts"),
        "export default { e2e: { specPattern: 'tests/e2e/**/*.cy.ts' } };\n",
      );
      await fs.writeFile(
        path.join(tempRoot, "cypress-mcp.config.json"),
        JSON.stringify({
          cypressConfigFile: "config/custom.config.ts",
          defaultBrowser: "chrome",
          titleFilterSupport: true,
        }),
      );

      const loader = new ConfigLoader(tempRoot, logger);
      const config = await loader.load();

      expect(config.cypressConfigFile).toBe("config/custom.config.ts");
      expect(config.defaultBrowser).toBe("chrome");
      expect(config.specPattern).toEqual(["tests/e2e/**/*.cy.ts"]);
      expect(config.titleFilterSupport).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("should read the Cypress Cloud projectId from the Cypress config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-config-"));
    const previous = process.env["CYPRESS_PROJECT_ID"];
    delete process.env["CYPRESS_PROJECT_ID"];

    try {
      await fs.writeFile(
        path.join(tempRoot, "cypress.config.ts"),
        "export default { projectId: 'abc123', e2e: {} };\n",
      );

      const config = await new ConfigLoader(tempRoot, logger).load();
      expect(config.projectId).toBe("abc123");

      process.env["CYPRESS_PROJECT_ID"] = "fromenv";
      const fromEnv = await new ConfigLoader(tempRoot, logger).load();
      expect(fromEnv.projectId).toBe("fromenv");
    } finally {
      if (previous === undefined) delete process.env["CYPRESS_PROJECT_ID"];
      else process.env["CYPRESS_PROJECT_ID"] = previous;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  describe("reloads when an input file changes", () => {
    async function withProject(
      files: Record<string, string>,
      run: (
        root: string,
        write: (file: string, body: string) => Promise<void>,
      ) => Promise<void>,
    ): Promise<void> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-config-"));
      // Each write gets a later mtime, so the change is seen even on file
      // systems with coarse timestamps.
      let tick = Date.now() / 1000;
      const write = async (file: string, body: string): Promise<void> => {
        const absolute = path.join(root, file);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, body);
        tick += 10;
        await fs.utimes(absolute, tick, tick);
      };
      try {
        for (const [file, body] of Object.entries(files)) {
          await write(file, body);
        }
        await run(root, write);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }

    it("returns the cached config while nothing changes", async () => {
      await withProject(
        { "cypress.config.js": "module.exports = { e2e: {} };" },
        async (root) => {
          const loader = new ConfigLoader(root, logger);
          expect(await loader.load()).toBe(await loader.load());
        },
      );
    });

    it("picks up a new specPattern in the Cypress config", async () => {
      await withProject(
        {
          "cypress.config.js":
            "module.exports = { e2e: { specPattern: 'a/**/*.cy.js' } };",
        },
        async (root, write) => {
          const loader = new ConfigLoader(root, logger);
          expect((await loader.load()).specPattern).toEqual(["a/**/*.cy.js"]);

          await write(
            "cypress.config.js",
            "module.exports = { e2e: { specPattern: 'b/**/*.cy.js' } };",
          );
          expect((await loader.load()).specPattern).toEqual(["b/**/*.cy.js"]);
        },
      );
    });

    it("enables title filtering once @cypress/grep is added to the support file", async () => {
      await withProject(
        {
          "cypress.config.js": "module.exports = { e2e: {} };",
          "cypress/support/e2e.js": "// nothing yet\n",
        },
        async (root, write) => {
          const loader = new ConfigLoader(root, logger);
          expect((await loader.load()).titleFilterSupport).toBe(false);

          await write("cypress/support/e2e.js", "require('@cypress/grep')();\n");
          expect((await loader.load()).titleFilterSupport).toBe(true);
        },
      );
    });

    it("follows changes in a relative import of the config", async () => {
      await withProject(
        {
          "cypress.config.js":
            "const shared = require('./shared');\nmodule.exports = shared;",
          "shared.js": "module.exports = { screenshotsFolder: 'shots/one' };",
        },
        async (root, write) => {
          const loader = new ConfigLoader(root, logger);
          expect((await loader.load()).screenshotsDir).toBe("shots/one");

          await write(
            "shared.js",
            "module.exports = { screenshotsFolder: 'shots/two' };",
          );
          expect((await loader.load()).screenshotsDir).toBe("shots/two");
        },
      );
    });

    it("notices a cypress-mcp.config.json created after the first load", async () => {
      await withProject(
        { "cypress.config.js": "module.exports = { e2e: {} };" },
        async (root, write) => {
          const loader = new ConfigLoader(root, logger);
          expect((await loader.load()).defaultBrowser).toBeUndefined();

          await write(
            "cypress-mcp.config.json",
            JSON.stringify({ defaultBrowser: "chrome" }),
          );
          expect((await loader.load()).defaultBrowser).toBe("chrome");
        },
      );
    });
  });
});
