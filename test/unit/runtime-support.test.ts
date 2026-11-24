// runtime/support.js runs in the browser, bundled into the spec. Here it runs
// in a VM context with stand-ins for Mocha's globals and Cypress, to check the
// title filter, repeat and the failure payload. The page snapshot itself is
// checked against a real browser in test/e2e/smoke.mjs; the masking of
// secrets is checked here, on a stand-in page.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const SOURCE = fs.readFileSync("runtime/support.js", "utf-8");

interface Registered {
  title: string;
  skipped?: boolean;
}

/**
 * Loads the runtime with `options` and a spec registering tests through it.
 * `app` is the app's window that cy.state("window") returns, if any.
 */
function load(
  options: object,
  spec: (globals: Record<string, (...args: unknown[]) => unknown>) => void,
  app?: object,
) {
  const registered: Registered[] = [];
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const hooks: ((this: unknown) => void)[] = [];
  const tasks: { name: string; payload: Record<string, unknown> }[] = [];

  const it = Object.assign(
    (title: string) => {
      registered.push({ title });
      return { timeout: () => undefined };
    },
    {
      only: (title: string) => registered.push({ title }),
      skip: (title: string) => registered.push({ title, skipped: true }),
    },
  );
  const describeFn = Object.assign(
    (_title: string, ...rest: unknown[]) => (rest[rest.length - 1] as () => void)(),
    {
      only: (_title: string, body: () => void) => body(),
      skip: (_title: string, body: () => void) => body(),
    },
  );

  const window: Record<string, unknown> = {
    it,
    describe: describeFn,
    context: describeFn,
  };
  const context = vm.createContext({
    window,
    globalThis: undefined as unknown,
    afterEach: (fn: (this: unknown) => void) => hooks.push(fn),
    Cypress: {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        (handlers[event] ??= []).push(handler);
      },
      spec: { relative: "cypress/e2e/a.cy.js" },
    },
    cy: {
      state: (key: string) => (key === "window" ? app : undefined),
      task: (name: string, payload: Record<string, unknown>) =>
        tasks.push({ name, payload }),
    },
  });
  (context as { globalThis: unknown }).globalThis = Object.assign(context, {
    __cypressMcp: options,
  });

  vm.runInContext(SOURCE, context);
  spec(window as Record<string, (...args: unknown[]) => unknown>);
  return { registered, handlers, hooks, tasks };
}

describe("runtime/support.js title filter", () => {
  const spec = (g: Record<string, (...args: unknown[]) => unknown>): void => {
    g["describe"]!("Checkout", () => {
      g["it"]!("adds one item", () => undefined);
      g["context"]!("when logged in", () => {
        g["it"]!("shows the cart", () => undefined);
      });
    });
    g["it"]!("outside any suite", () => undefined);
  };

  it("registers every test without options", () => {
    const { registered } = load({}, spec);
    expect(registered.map((r) => r.title)).toEqual([
      "adds one item",
      "shows the cart",
      "outside any suite",
    ]);
  });

  it("keeps exact full titles, nested suites included", () => {
    const { registered } = load(
      { filter: { titles: ["Checkout when logged in shows the cart"] } },
      spec,
    );
    expect(registered.map((r) => r.title)).toEqual(["shows the cart"]);
  });

  it("keeps titles that contain the text, and repeats them", () => {
    const { registered } = load({ filter: { contains: "Checkout" }, repeat: 2 }, spec);
    expect(registered.map((r) => r.title)).toEqual([
      "adds one item (repeat 1/2)",
      "adds one item (repeat 2/2)",
      "shows the cart (repeat 1/2)",
      "shows the cart (repeat 2/2)",
    ]);
  });

  it("returns a chainable stand-in for an omitted test", () => {
    load({ filter: { titles: ["nothing"] } }, (g) => {
      const result = g["it"]!("left out", () => undefined) as {
        timeout(): { retries(): unknown };
      };
      expect(() => result.timeout().retries()).not.toThrow();
    });
  });
});

describe("runtime/support.js failure payload", () => {
  it("sends the console, requests and commands of a failed test through the task", () => {
    const { handlers, hooks, tasks } = load(
      { task: "cypressMcp:failureContext" },
      () => undefined,
    );

    handlers["test:before:run"]![0]!();
    handlers["log:added"]![0]!({
      id: "1",
      instrument: "command",
      name: "visit",
      message: "/",
      state: "passed",
    });
    handlers["log:added"]![0]!({
      id: "2",
      instrument: "command",
      name: "get",
      message: "[data-cy=x]",
      state: "pending",
    });
    handlers["uncaught:exception"]![0]!(new Error("boom"));
    handlers["log:changed"]![0]!({
      id: "2",
      state: "failed",
      message: "**[data-cy=x]**",
    });

    const failed = { state: "failed", fullTitle: () => "A fails", currentRetry: () => 1 };
    hooks[0]!.call({ currentTest: failed });
    // A passing test sends nothing.
    hooks[0]!.call({ currentTest: { state: "passed", fullTitle: () => "A passes" } });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.name).toBe("cypressMcp:failureContext");
    expect(tasks[0]!.payload).toMatchObject({
      spec: "cypress/e2e/a.cy.js",
      title: "A fails",
      attempt: 1,
      failedSelector: "[data-cy=x]",
      console: [{ level: "uncaught", text: "boom" }],
      commands: [
        { name: "visit", state: "passed" },
        { name: "get", message: "[data-cy=x]", state: "failed" },
      ],
    });
  });
});

// ---- secrets ---------------------------------------------------------------

/** A stand-in element with what the outline reads: tag, attributes, value, text. */
function element(
  tag: string,
  attrs: Record<string, string> = {},
  options: { text?: string; value?: string; children?: object[] } = {},
): object {
  const textNode = options.text
    ? { nodeType: 3, nodeValue: options.text, nextSibling: null }
    : null;
  return {
    tagName: tag.toUpperCase(),
    id: attrs["id"] ?? "",
    type: attrs["type"] ?? "",
    value: options.value ?? "",
    hidden: false,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (name: string) => attrs[name] ?? null,
    getClientRects: () => [{}],
    children: options.children ?? [],
    firstChild: textNode,
    textContent: options.text ?? "",
  };
}

/** The app's window: a URL, a body, console, fetch and error events. */
function appWindow(href: string, body: object[]) {
  const listeners: Record<string, (event: object) => void> = {};
  const win = {
    location: { href },
    document: {
      title: "Shop",
      body: element("body", {}, { children: body }),
      querySelectorAll: () => [],
    },
    // The runtime wraps these on window:before:load.
    console: {
      error: (..._args: unknown[]): void => undefined,
      warn: (..._args: unknown[]): void => undefined,
    },
    addEventListener: (type: string, listener: (event: object) => void) => {
      listeners[type] = listener;
    },
    fetch: (_url: string) => Promise.resolve({ ok: false, status: 401, url: "" }),
    getComputedStyle: () => ({ display: "block" }),
  };
  return { win, listeners };
}

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXBhcnQ";
const HEX_TOKEN = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
const API_KEY = "tok_4eC39HqLyjWDarjtT1zdp7dcAbX9q2Lw";
const UUID = "550e8400-e29b-41d4-a716-446655440000";

/** Runs one failing test against `app` and returns the payload sent to the task. */
async function failWith(
  app: ReturnType<typeof appWindow>,
  during: (win: ReturnType<typeof appWindow>["win"]) => Promise<void> | void,
  commands: { name: string; message: string }[] = [],
): Promise<Record<string, unknown>> {
  const { handlers, hooks, tasks } = load(
    { task: "cypressMcp:failureContext" },
    () => undefined,
    app.win,
  );
  handlers["test:before:run"]![0]!();
  handlers["window:before:load"]![0]!(app.win);
  commands.forEach((command, i) =>
    handlers["log:added"]![0]!({ id: String(i), instrument: "command", ...command }),
  );
  await during(app.win);
  handlers["log:changed"]![0]!({ id: "x", name: "click", state: "failed" });
  hooks[0]!.call({
    currentTest: { state: "failed", fullTitle: () => "A fails", currentRetry: () => 0 },
  });
  return tasks[0]!.payload;
}

describe("runtime/support.js secrets", () => {
  it("masks secret query and fragment values in URLs, keeps the rest readable", async () => {
    const app = appWindow(
      `http://localhost:3000/reset/confirm?token=abc123&page=2&sig=x9#access_token=${JWT}&state=ok`,
      [
        element(
          "a",
          {
            href: "/f.pdf?X-Amz-Credential=AKIDEXAMPLE%2F20261124&X-Amz-Signature=0f1e&lang=fr",
          },
          { text: "Report" },
        ),
        element("a", { href: `/orders?id=${UUID}` }, { text: "Order" }),
        element("a", { href: "https://alice:pw1@cdn.example.com/x" }, { text: "CDN" }),
      ],
    );

    const payload = await failWith(app, async (win) => {
      await win.fetch(`/api/items?apikey=k-123&q=shoes&cursor=${HEX_TOKEN}`);
      app.listeners["error"]!({
        target: {
          src: "https://cdn.example.com/a.js;jsessionid=1A2B3C?v=2",
          tagName: "SCRIPT",
        },
      });
    });

    expect(payload["url"]).toBe(
      "http://localhost:3000/reset/confirm?token=***&page=2&sig=***#access_token=***&state=ok",
    );
    expect(payload["network"]).toEqual([
      { method: "GET", url: "/api/items?apikey=***&q=shoes&cursor=***", status: 401 },
      {
        method: "GET",
        url: "https://cdn.example.com/a.js;jsessionid=***?v=2",
        status: "failed to load",
        kind: "script",
      },
    ]);
    const outline = payload["outline"] as string;
    expect(outline).toContain(
      'a href="/f.pdf?X-Amz-Credential=***&X-Amz-Signature=***&lang=fr" "Report"',
    );
    expect(outline).toContain(`a href="/orders?id=${UUID}" "Order"`);
    expect(outline).toContain('a href="https://***@cdn.example.com/x" "CDN"');
  });

  it("never sends the value of a secret field or a token typed into any field", async () => {
    const app = appWindow("http://localhost:3000/settings", [
      element("input", { type: "text", name: "apiKey" }, { value: "short1" }),
      element("input", { autocomplete: "one-time-code" }, { value: "123456" }),
      element("input", { id: "iban" }, { value: "BE71096123456769" }),
      element("input", { type: "password" }, { value: "hunter2" }),
      // A password shown as text by an eye toggle.
      element(
        "input",
        { type: "text", autocomplete: "current-password" },
        { value: "hunter3" },
      ),
      element("input", { name: "search" }, { value: API_KEY }),
      element("input", { type: "email", name: "email" }, { value: "a@b.c" }),
      element("input", { name: "keyword" }, { value: "shoes" }),
      element("input", { name: "order" }, { value: UUID }),
      element("div", { "data-api-key": "k-123", "data-cy": "panel" }, { text: "Keys" }),
    ]);

    const outline = (await failWith(app, () => undefined))["outline"] as string;

    for (const secret of ["short1", "123456", "BE71", "hunter", API_KEY]) {
      expect(outline).not.toContain(secret);
    }
    expect(outline).toContain('input type=text name="apiKey" value="***"');
    expect(outline).toContain('input type=password value="***"');
    expect(outline).toContain('input type=email name="email" value="a@b.c"');
    expect(outline).toContain('input name="keyword" value="shoes"');
    expect(outline).toContain(`input name="order" value="${UUID}"`);
    expect(outline).toContain('div data-api-key="***" data-cy="panel" "Keys"');
  });

  it("masks tokens and bearer credentials in console text and the command log", async () => {
    const app = appWindow("http://localhost:3000/", []);

    const payload = await failWith(
      app,
      (win) => {
        win.console.error("Request failed", "Authorization: Bearer abc.def-123");
        win.console.warn(`token ${JWT} expired`);
        win.console.error("GET /api?access_token=abc&page=2 failed");
        win.console.error(`key ${HEX_TOKEN} rejected`);
        win.console.error("Bearer undefined");
        win.console.error(
          `order ${UUID} not found, see how-to-configure-cypress-2-for-ci`,
        );
        win.console.error("Uncaught TypeError: session is undefined");
      },
      [
        { name: "visit", message: "/reset?token=abc123" },
        { name: "type", message: API_KEY },
        { name: "get", message: "[data-cy=order-row-5f8d0d55b54764421b7156c9]" },
      ],
    );

    expect((payload["console"] as { text: string }[]).map((c) => c.text)).toEqual([
      "Request failed Authorization: Bearer ***",
      "token *** expired",
      "GET /api?access_token=***&page=2 failed",
      "key *** rejected",
      "Bearer undefined",
      `order ${UUID} not found, see how-to-configure-cypress-2-for-ci`,
      "Uncaught TypeError: session is undefined",
    ]);
    expect(payload["commands"]).toMatchObject([
      { name: "visit", message: "/reset?token=***" },
      { name: "type", message: "***" },
      // A selector is kept as it is: the page is queried with it.
      { name: "get", message: "[data-cy=order-row-5f8d0d55b54764421b7156c9]" },
    ]);
  });

  it("does not leak the piece of a token cut off by the length limit", async () => {
    // Masking the long JWT pulls the end of the cut text into the 300 shown.
    const jwt = `eyJ${"a".repeat(300)}.${"b".repeat(200)}`;
    const filler = "word ".repeat(Math.ceil((600 - 25 - jwt.length - 1) / 5));
    const head = `${jwt} ${filler}`.slice(0, 600 - 25);
    const payload = await failWith(appWindow("http://localhost:3000/", []), (win) => {
      win.console.error(`${head}${HEX_TOKEN} and more`);
      win.console.error("x".repeat(700));
    });

    const [cut, word] = (payload["console"] as { text: string }[]).map((c) => c.text);
    expect(cut!.startsWith("*** word word")).toBe(true);
    expect(cut).not.toContain(HEX_TOKEN.slice(0, 12));
    expect(word).toBe(`${"x".repeat(300)}...`);
  });
});
