// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
//
// Browser side of cypress-mcp, bundled into the spec by Cypress after the
// project's own support file. cypress-mcp writes it for each run with its
// options in globalThis.__cypressMcp, set on the line above this code.
//
// It does three things and must never fail a test:
// - runs only the tests asked for (a title, file:line) and repeats them, by
//   wrapping describe/it the way @cypress/grep does, so neither needs the plugin;
// - records what the app did during each test: console errors, failed
//   requests, the Cypress command log;
// - when a test fails, snapshots the page at the failing command (URL, a
//   pruned DOM/ARIA outline, selectors on the page) and hands it to the
//   cypress-mcp task in an afterEach hook.
// Credentials in what it records are masked in the browser (see secrets).
//
// Plain ES2018 in one IIFE: it runs in whatever browser Cypress drives and is
// bundled by whatever preprocessor the project uses.
(function () {
  "use strict";

  var options = globalThis.__cypressMcp || {};
  var LIMITS = {
    outline: options.maxOutlineChars || 12000,
    visited: 6000,
    text: 80,
    message: 300,
    console: 20,
    network: 20,
    commands: 25,
    inventory: 400,
  };

  installFilter(options.filter, options.repeat);

  if (!options.task || typeof Cypress === "undefined") {
    return;
  }

  var state = freshState();

  function freshState() {
    return { console: [], network: [], commands: [], byId: {}, snapshot: null };
  }

  Cypress.on("test:before:run", function () {
    state = freshState();
  });

  Cypress.on("window:before:load", function (win) {
    guard(function () {
      hookConsole(win);
      hookNetwork(win);
    });
  });

  // Returns nothing, so Cypress (and the project's own handlers) decide
  // whether the exception fails the test.
  Cypress.on("uncaught:exception", function (err) {
    guard(function () {
      push(
        state.console,
        { level: "uncaught", text: scrub(messageOf(err), LIMITS.message) },
        LIMITS.console,
      );
    });
  });

  Cypress.on("log:added", function (attrs) {
    guard(function () {
      if (!attrs || attrs.instrument !== "command") return;
      var entry = {
        name: String(attrs.name || ""),
        message: commandMessage(attrs.name, attrs.message || ""),
        state: attrs.state || "pending",
      };
      state.byId[attrs.id] = entry;
      push(state.commands, entry, LIMITS.commands);
    });
  });

  // The page is captured at the command that failed: by the time afterEach
  // runs, the test's own afterEach hooks may have navigated away.
  Cypress.on("log:changed", function (attrs) {
    guard(function () {
      if (!attrs) return;
      var entry = state.byId[attrs.id];
      if (entry) {
        entry.state = attrs.state || entry.state;
        if (attrs.message) entry.message = commandMessage(entry.name, attrs.message);
      }
      if (attrs.state === "failed" && !state.snapshot) {
        state.snapshot = capture(
          entry || { name: attrs.name, message: String(attrs.message || "") },
        );
      }
    });
  });

  afterEach(function () {
    var test = this.currentTest;
    if (!test || test.state !== "failed") return;

    var payload = null;
    guard(function () {
      var snapshot = state.snapshot || capture(null);
      payload = {
        spec: Cypress.spec && Cypress.spec.relative,
        title: test.fullTitle(),
        attempt: typeof test.currentRetry === "function" ? test.currentRetry() : 0,
        url: snapshot.url,
        pageTitle: snapshot.pageTitle,
        failedSelector: snapshot.failedSelector,
        matches: snapshot.matches,
        outline: snapshot.outline,
        outlineTruncated: snapshot.truncated,
        inventory: snapshot.inventory,
        console: state.console,
        network: state.network,
        commands: state.commands.slice(-LIMITS.commands),
      };
    });
    if (payload) {
      cy.task(options.task, payload, { log: false });
    }
  });

  // ---- page snapshot -----------------------------------------------------

  var SKIP_TAGS = {
    SCRIPT: 1,
    STYLE: 1,
    NOSCRIPT: 1,
    TEMPLATE: 1,
    LINK: 1,
    META: 1,
    HEAD: 1,
    PATH: 1,
    DEFS: 1,
  };
  var KEEP_TAGS = {
    A: 1,
    BUTTON: 1,
    INPUT: 1,
    SELECT: 1,
    TEXTAREA: 1,
    LABEL: 1,
    FORM: 1,
    IMG: 1,
    DIALOG: 1,
    H1: 1,
    H2: 1,
    H3: 1,
    H4: 1,
    H5: 1,
    H6: 1,
    NAV: 1,
    MAIN: 1,
    HEADER: 1,
    FOOTER: 1,
    TABLE: 1,
    TR: 1,
    TH: 1,
    TD: 1,
    UL: 1,
    OL: 1,
    LI: 1,
    OPTION: 1,
    IFRAME: 1,
    SUMMARY: 1,
  };
  var ARIA_STATES = [
    "aria-label",
    "aria-expanded",
    "aria-checked",
    "aria-selected",
    "aria-disabled",
    "aria-invalid",
    "aria-current",
    "aria-pressed",
    "aria-live",
  ];

  function capture(failedCommand) {
    var snapshot = {
      url: null,
      pageTitle: null,
      failedSelector: null,
      matches: null,
      outline: "",
      truncated: false,
      inventory: [],
    };
    guard(function () {
      snapshot.failedSelector = selectorOf(failedCommand);
      var win = autWindow();
      if (!win) return;
      var href = String(win.location.href);
      snapshot.url = maskUrl(href);
      // Cypress's blank page between tests: the test never visited the app.
      if (href === "about:blank") return;
      var doc = win.document;
      snapshot.pageTitle = clip(doc.title || "", LIMITS.text);
      if (!doc.body) return;

      var matched = [];
      if (snapshot.failedSelector) {
        try {
          matched = Array.prototype.slice.call(
            doc.querySelectorAll(snapshot.failedSelector),
          );
          snapshot.matches = matched.length;
        } catch {
          // Not a CSS selector (an alias, cy.contains text): no marking.
        }
      }
      var result = outline(doc.body, matched, win);
      snapshot.outline = result.text;
      snapshot.truncated = result.truncated;
      snapshot.inventory = result.inventory;
    });
    return snapshot;
  }

  /** The app's window, the iframe Cypress drives. */
  function autWindow() {
    try {
      var win = cy.state("window");
      if (win && win.document) return win;
    } catch {
      // Older or newer Cypress without cy.state: try the iframe.
    }
    try {
      var frame = window.top.document.querySelector("iframe.aut-iframe");
      if (frame && frame.contentWindow && frame.contentWindow.document)
        return frame.contentWindow;
    } catch {
      // Cross-origin app: no page details.
    }
    return null;
  }

  /** The selector of the failed command, or of the last cy.get/find before it. */
  function selectorOf(command) {
    var candidates = [];
    if (command) candidates.push(command);
    for (var i = state.commands.length - 1; i >= 0; i--)
      candidates.push(state.commands[i]);
    for (var j = 0; j < candidates.length; j++) {
      var c = candidates[j];
      if (
        (c.name === "get" || c.name === "find") &&
        c.message &&
        c.message.charAt(0) !== "@"
      ) {
        return c.message;
      }
    }
    return null;
  }

  /**
   * Indented outline of the elements an agent can target: interactive and
   * landmark elements, anything with an id, data-*, role or aria attribute,
   * and elements with their own text. Hidden elements are skipped.
   */
  function outline(body, matched, win) {
    var lines = [];
    var inventory = [];
    var length = 0;
    var truncated = false;
    var visited = 0;

    function walk(el, depth) {
      if (truncated || visited > LIMITS.visited) {
        truncated = true;
        return;
      }
      visited++;
      if (SKIP_TAGS[el.tagName]) return;
      if (isHidden(el, win)) return;

      var describe = describeElement(el, matched);
      var nextDepth = depth;
      if (describe) {
        var line = repeat("  ", depth) + describe;
        if (length + line.length + 1 > LIMITS.outline) {
          truncated = true;
          return;
        }
        lines.push(line);
        length += line.length + 1;
        nextDepth = depth + 1;
        addInventory(el, inventory);
      }
      if (el.tagName === "SVG" || el.tagName === "svg") return;
      var children = el.children;
      for (var i = 0; i < children.length; i++) walk(children[i], nextDepth);
    }

    walk(body, 0);

    // Make sure the elements the failing selector matched are in the outline.
    if (truncated) {
      for (var m = 0; m < matched.length && m < 5; m++) {
        var d = describeElement(matched[m], matched);
        if (d) lines.push("... " + d);
      }
    }
    return { text: lines.join("\n"), truncated: truncated, inventory: inventory };
  }

  function isHidden(el, win) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    if (el.tagName === "INPUT" && el.type === "hidden") return true;
    try {
      // Cheaper than getComputedStyle for most elements: a box means rendered.
      if (el.getClientRects().length > 0 || el.tagName === "OPTION") return false;
      // No box: display: none, unless display: contents (its children render).
      return win.getComputedStyle(el).display !== "contents";
    } catch {
      return false;
    }
  }

  function describeElement(el, matched) {
    var tag = el.tagName.toLowerCase();
    var parts = [];
    var interesting = KEEP_TAGS[el.tagName] === 1;

    if (el.id) {
      parts.push("#" + el.id);
      interesting = true;
    }
    var attrs = el.attributes;
    var dataCount = 0;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.indexOf("data-") === 0 && dataCount < 4 && name !== "data-reactroot") {
        var shown = secretName(name.slice(5)) ? MASK : clip(attrs[i].value, 60);
        parts.push(name + "=" + JSON.stringify(shown));
        dataCount++;
        interesting = true;
      }
    }
    var role = el.getAttribute("role");
    if (role) {
      parts.push("role=" + role);
      interesting = true;
    }
    for (var a = 0; a < ARIA_STATES.length; a++) {
      var value = el.getAttribute(ARIA_STATES[a]);
      if (value !== null) {
        parts.push(ARIA_STATES[a] + "=" + JSON.stringify(clip(value, 60)));
        interesting = true;
      }
    }
    if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button") {
      var type = el.getAttribute("type");
      if (type) parts.push("type=" + type);
      var fieldName = el.getAttribute("name");
      if (fieldName) parts.push("name=" + JSON.stringify(fieldName));
      var placeholder = el.getAttribute("placeholder");
      if (placeholder) parts.push("placeholder=" + JSON.stringify(clip(placeholder, 60)));
      // Never the value of a password, key or one-time-code field, nor a token.
      if (tag !== "button" && el.value) {
        var secret = secretField(el) || secretValue(String(el.value));
        parts.push("value=" + JSON.stringify(secret ? MASK : scrub(el.value, 60)));
      }
      if (el.disabled) parts.push("disabled");
      if (el.checked) parts.push("checked");
    }
    if (tag === "a") {
      var href = el.getAttribute("href");
      if (href) parts.push("href=" + JSON.stringify(scrub(href, 80, maskUrl)));
    }
    if (tag === "img") {
      var alt = el.getAttribute("alt");
      parts.push("alt=" + JSON.stringify(clip(alt || "", 60)));
    }

    var text = ownText(el);
    if (text) interesting = true;
    if (!interesting) return null;

    var line =
      tag +
      (parts.length ? " " + parts.join(" ") : "") +
      (text ? " " + JSON.stringify(text) : "");
    if (matched.indexOf(el) !== -1) line += "  <== matches the failing selector";
    return line;
  }

  /** Text directly inside the element (not its children's), trimmed. */
  function ownText(el) {
    var text = "";
    for (var node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) text += node.nodeValue;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (
      !text &&
      (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "LABEL")
    ) {
      text = (el.textContent || "").replace(/\s+/g, " ").trim();
    }
    return clip(text, LIMITS.text);
  }

  /** Selectors an agent could use, for suggestions when a selector finds nothing. */
  function addInventory(el, inventory) {
    if (inventory.length >= LIMITS.inventory) return;
    var attrs = [
      "data-cy",
      "data-test",
      "data-testid",
      "data-test-id",
      "data-qa",
      "aria-label",
      "name",
    ];
    for (var i = 0; i < attrs.length; i++) {
      var value = el.getAttribute(attrs[i]);
      if (value)
        inventory.push("[" + attrs[i] + "=" + JSON.stringify(clip(value, 80)) + "]");
    }
    if (el.id) inventory.push("#" + el.id);
    var tag = el.tagName;
    if (tag === "BUTTON" || tag === "A" || el.getAttribute("role") === "button") {
      var text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text) inventory.push(tag.toLowerCase() + " " + JSON.stringify(clip(text, 60)));
    }
  }

  // ---- console and network ----------------------------------------------

  function hookConsole(win) {
    ["error", "warn"].forEach(function (level) {
      var original = win.console && win.console[level];
      if (typeof original !== "function" || original.__cypressMcp) return;
      var wrapped = function () {
        var args = arguments;
        guard(function () {
          push(
            state.console,
            {
              level: level,
              text: scrub(
                Array.prototype.map.call(args, messageOf).join(" "),
                LIMITS.message,
              ),
            },
            LIMITS.console,
          );
        });
        return original.apply(this, arguments);
      };
      wrapped.__cypressMcp = true;
      win.console[level] = wrapped;
    });

    win.addEventListener(
      "error",
      function (event) {
        guard(function () {
          var target = event.target;
          if (target && target !== win && (target.src || target.href)) {
            push(
              state.network,
              {
                method: "GET",
                url: scrub(target.src || target.href, 200, maskUrl),
                status: "failed to load",
                kind: String(target.tagName || "").toLowerCase(),
              },
              LIMITS.network,
            );
          } else if (event.message) {
            push(
              state.console,
              {
                level: "error",
                text: scrub("Uncaught " + event.message, LIMITS.message),
              },
              LIMITS.console,
            );
          }
        });
      },
      true,
    );

    win.addEventListener("unhandledrejection", function (event) {
      guard(function () {
        push(
          state.console,
          {
            level: "error",
            text: scrub(
              "Unhandled rejection: " + messageOf(event.reason),
              LIMITS.message,
            ),
          },
          LIMITS.console,
        );
      });
    });
  }

  function hookNetwork(win) {
    if (typeof win.fetch === "function" && !win.fetch.__cypressMcp) {
      var originalFetch = win.fetch;
      var wrappedFetch = function (input, init) {
        var method = String(
          (init && init.method) || (input && input.method) || "GET",
        ).toUpperCase();
        var url =
          typeof input === "string"
            ? input
            : input && input.url
              ? input.url
              : String(input);
        return originalFetch.apply(this, arguments).then(
          function (response) {
            if (!response.ok) recordRequest(method, response.url || url, response.status);
            return response;
          },
          function (error) {
            recordRequest(method, url, "network error: " + messageOf(error));
            throw error;
          },
        );
      };
      wrappedFetch.__cypressMcp = true;
      win.fetch = wrappedFetch;
    }

    var XHR = win.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__cypressMcp) {
      var open = XHR.prototype.open;
      var send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__cypressMcpRequest = {
          method: String(method || "GET").toUpperCase(),
          url: String(url),
        };
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var request = this.__cypressMcpRequest;
        if (request) {
          // An arrow function: `this` stays the request.
          this.addEventListener("loadend", () => {
            if (this.status === 0 || this.status >= 400) {
              recordRequest(
                request.method,
                this.responseURL || request.url,
                this.status === 0 ? "network error" : this.status,
              );
            }
          });
        }
        return send.apply(this, arguments);
      };
      XHR.prototype.__cypressMcp = true;
    }
  }

  function recordRequest(method, url, status) {
    guard(function () {
      push(
        state.network,
        { method: method, url: scrub(url, 200, maskUrl), status: status },
        LIMITS.network,
      );
    });
  }

  // ---- title filter and repeat --------------------------------------------

  /**
   * Registers only the tests asked for, each `repeat` times. Wrapping happens
   * here, after the project's support file, so a grep plugin it registered
   * still sees every registration that passes.
   */
  function installFilter(filter, repeatCount) {
    var titles = filter && filter.titles && filter.titles.length ? filter.titles : null;
    var contains = filter && typeof filter.contains === "string" ? filter.contains : null;
    var times =
      typeof repeatCount === "number" && repeatCount > 1 ? Math.floor(repeatCount) : 1;
    if (!titles && contains === null && times === 1) return;
    if (typeof window.it !== "function" || typeof window.describe !== "function") return;

    var suites = [];

    function wanted(fullTitle) {
      if (titles && titles.indexOf(fullTitle) !== -1) return true;
      if (contains !== null && fullTitle.indexOf(contains) !== -1) return true;
      return !titles && contains === null;
    }

    function wrapSuite(original) {
      if (typeof original !== "function") return original;
      return function () {
        var args = Array.prototype.slice.call(arguments);
        var last = args.length - 1;
        if (typeof args[0] === "string" && typeof args[last] === "function") {
          var title = args[0];
          var body = args[last];
          args[last] = function () {
            suites.push(title);
            try {
              return body.apply(this, arguments);
            } finally {
              suites.pop();
            }
          };
        }
        return original.apply(this, args);
      };
    }

    // What an omitted test returns, so `it(...).timeout(...)` chains still work.
    var omitted = {
      timeout: function () {
        return omitted;
      },
      retries: function () {
        return omitted;
      },
      slow: function () {
        return omitted;
      },
      skip: function () {
        return omitted;
      },
    };

    function wrapTest(original, filterIt) {
      if (typeof original !== "function") return original;
      return function () {
        var args = Array.prototype.slice.call(arguments);
        if (!filterIt || typeof args[0] !== "string") return original.apply(this, args);
        var title = args[0];
        var fullTitle = suites.concat([title]).join(" ").trim();
        if (!wanted(fullTitle)) return omitted;
        if (times === 1) return original.apply(this, args);
        var registered;
        for (var k = 1; k <= times; k++) {
          var copy = args.slice();
          copy[0] = title + " (repeat " + k + "/" + times + ")";
          registered = original.apply(this, copy);
        }
        return registered;
      };
    }

    ["describe", "context"].forEach(function (name) {
      var original = window[name];
      if (typeof original !== "function") return;
      var wrapped = wrapSuite(original);
      wrapped.only = wrapSuite(original.only);
      wrapped.skip = wrapSuite(original.skip);
      window[name] = wrapped;
    });
    ["xdescribe", "xcontext"].forEach(function (name) {
      if (typeof window[name] === "function") window[name] = wrapSuite(window[name]);
    });
    ["it", "specify"].forEach(function (name) {
      var original = window[name];
      if (typeof original !== "function") return;
      var wrapped = wrapTest(original, true);
      wrapped.only = wrapTest(original.only, true);
      // Skipped tests stay as they are: they are reported as pending.
      wrapped.skip = original.skip;
      window[name] = wrapped;
    });
  }

  // ---- secrets ------------------------------------------------------------
  //
  // The payload goes to the agent, so credentials are masked before they
  // leave the browser: in URLs (the page, failed requests, links)
  // the values of secret parameters, the values of secret form fields, and in
  // any text JWTs, Bearer credentials and other token shaped strings. Short
  // harmless values such as page=2 stay readable: they help debugging.

  var MASK = "***";
  // One word of a parameter or field name that marks a secret: apiKey,
  // access_token, X-Amz-Signature, one-time-code, cc-csc. Whole words or word
  // endings, so "keyword", "author" and "design" stay readable.
  var SECRET_WORD =
    /^(?:code|sig|pin|pwd|pass|sid|ssn|iban|cc|cvc|cvv|csc)s?$|(?:token|secret|key|passw(?:or)?d|passcode|signature|sess(?:ion)?(?:id)?|credential|auth|jwt|otp)s?$/;
  var JWT = /\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g;
  // "Bearer undefined" is kept: it is the bug, not a secret.
  var BEARER = /\b([Bb]earer|Basic)\s+(?!(?:undefined|null)\b)[\w.~+/=-]+/g;
  // key=value after ? # & or ;: a URL parameter, also inside console text.
  var PARAM = /([?#&;])([^?#&;=\s]+)=([^?#&;\s"'<>]+)/g;
  // 32 url-safe characters or more. API keys, session ids and signatures are
  // 32 to 64 long or more; ids worth reading are shorter (ObjectId 24, ULID
  // 26) or made of short groups (UUID, slugs), which tokenShaped lets through.
  var RUN = /[\w-]{32,}/g;

  /** Text with tokens, Bearer credentials and secret parameters masked. */
  function maskText(text) {
    return String(text)
      .replace(JWT, MASK)
      .replace(BEARER, "$1 " + MASK)
      .replace(PARAM, function (match, separator, key, value) {
        return secretName(key) || secretValue(value)
          ? separator + key + "=" + MASK
          : match;
      })
      .replace(RUN, function (run) {
        return tokenShaped(run) ? MASK : run;
      });
  }

  /** A URL with its scheme, host, path and parameter names, secrets masked. */
  function maskUrl(url) {
    var text = String(url).replace(
      /^([a-z][\w+.-]*:\/\/)[^/?#@\s]*@/i,
      "$1" + MASK + "@",
    );
    var cut = text.search(/[?#;]/);
    return cut === -1 ? text : text.slice(0, cut) + maskText(text.slice(cut));
  }

  /** Whether a parameter, field or attribute name looks like it holds a secret. */
  function secretName(name) {
    var words = String(name || "")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z\d]+/);
    for (var i = 0; i < words.length; i++) {
      if (SECRET_WORD.test(words[i])) return true;
    }
    return false;
  }

  /** Whether a form field holds a secret, by its name, id, autocomplete or type. */
  function secretField(el) {
    var attrs = ["name", "id", "autocomplete", "type"];
    for (var i = 0; i < attrs.length; i++) {
      if (secretName(el.getAttribute(attrs[i]))) return true;
    }
    return false;
  }

  /** A whole value that is a token: 32+ characters of a key alphabet, token shaped. */
  function secretValue(value) {
    var text = value;
    try {
      text = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding: check it as it is.
    }
    return /^[\w+/=.~-]{32,}$/.test(text) && tokenShaped(text);
  }

  /**
   * Whether text has 13 or more letters and digits in a row, mixed. A random
   * key always does; words, numbers, UUIDs (groups of 12 at most) and slugs
   * do not.
   */
  function tokenShaped(text) {
    var runs = String(text).match(/[A-Za-z\d]{13,}/g) || [];
    for (var i = 0; i < runs.length; i++) {
      if (/\d/.test(runs[i]) && /[A-Za-z]/.test(runs[i])) return true;
    }
    return false;
  }

  /**
   * A command's message, masked. The selectors of get and find are kept as
   * they are: selectorOf queries the page with them, and test ids often end
   * in a database id that would read as a token.
   */
  function commandMessage(name, message) {
    var text = stripMarkdown(String(message));
    return name === "get" || name === "find"
      ? clip(text, LIMITS.message)
      : scrub(text, LIMITS.message);
  }

  /**
   * App text for the payload, masked (maskText, or maskUrl) and clipped. Long
   * text is cut first to bound the work. A token the cut leaves shorter than
   * 32 characters at the end would not be recognised, so that piece goes too.
   */
  function scrub(value, max, mask) {
    var text = String(value == null ? "" : value);
    if (text.length > max * 2) {
      text = text.slice(0, max * 2);
      var tail = /[\w-]+$/.exec(text);
      if (tail && tail[0].length < 32) text = text.slice(0, tail.index);
      text += "...";
    }
    return clip((mask || maskText)(text), max);
  }

  // ---- helpers ------------------------------------------------------------

  function guard(fn) {
    try {
      fn();
    } catch {
      // Context collection must never fail or slow down the user's test.
    }
  }

  function push(list, item, max) {
    list.push(item);
    if (list.length > max) list.shift();
  }

  function clip(value, max) {
    var text = String(value == null ? "" : value);
    return text.length > max ? text.slice(0, max) + "..." : text;
  }

  function stripMarkdown(text) {
    return text.replace(/\*\*/g, "");
  }

  function messageOf(value) {
    if (value == null) return String(value);
    if (typeof value === "string") return value;
    if (value instanceof Error || (value && typeof value.message === "string"))
      return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function repeat(text, count) {
    var out = "";
    for (var i = 0; i < count; i++) out += text;
    return out;
  }
})();
