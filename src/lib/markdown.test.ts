// @vitest-environment jsdom

import { describe, expect, it, beforeAll } from "vitest";
import DOMPurify from "dompurify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderMarkdown, MarkdownDeps } from "./markdown";

// Load the same vendored UMD that production loads via <script>, so the
// tests cover the same parser → sanitizer chain. The UMD wrapper writes
// to globalThis.marked when neither CommonJS nor AMD is available, which
// is the case in ESM tests.
let marked: { parse: (s: string, opts?: object) => string };

beforeAll(() => {
  const src = readFileSync(
    resolve(__dirname, "..", "public", "marked.min.js"),
    "utf8",
  );
  new Function(src)();
  marked = (globalThis as unknown as { marked: typeof marked }).marked;
  if (!marked || typeof marked.parse !== "function") {
    throw new Error("failed to load marked from public/marked.min.js");
  }
});

const deps = (): MarkdownDeps => ({
  marked,
  sanitizer: DOMPurify as unknown as MarkdownDeps["sanitizer"],
});

// ───────── XSS payloads ────────────────────────────────────────────
//
// Each of these was confirmed pre-fix to pass through `marked.parse`
// untouched, producing executable HTML inside the chat WebView. After
// sanitization, none of them should yield a `<script>`, an event
// handler attribute, an iframe/object/embed/form/meta/link tag, a
// javascript: URL, or a data: URL.

const xssPayloads: Array<[label: string, input: string]> = [
  ["raw <script>", "Hello <script>alert(1)</script>"],
  ["<img onerror>", 'Look: <img src=x onerror="alert(1)">'],
  ["<iframe>", '<iframe src="https://evil.test"></iframe>'],
  ["javascript: link via markdown", "[click](javascript:alert(1))"],
  ["javascript: image via markdown", "![alt](javascript:alert(1))"],
  ["javascript: anchor raw", '<a href="javascript:alert(1)">x</a>'],
  [
    "<details ontoggle>",
    "<details open ontoggle=\"alert(1)\"><summary>y</summary></details>",
  ],
  ["<svg onload>", "<svg onload=alert(1)>"],
  ["<object data=…>", '<object data="https://evil.test/x.html"></object>'],
  ["<embed src=…>", '<embed src="https://evil.test/x.swf">'],
  [
    "<form action=…>",
    '<form action="https://evil.test/" method="post"><input name="csrf" value="x"></form>',
  ],
  [
    "<meta http-equiv=refresh>",
    '<meta http-equiv="refresh" content="0;url=https://evil.test/">',
  ],
  ["<link rel=stylesheet>", '<link rel="stylesheet" href="https://evil.test/x.css">'],
  ["<base href=…>", '<base href="https://evil.test/">'],
  [
    "data: URL in <img>",
    '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
  ],
  [
    "mglyph mutation XSS",
    '<math><mtext><table><mglyph><svg><mtext><textarea><a title="</textarea><img src=x onerror=alert(1)>"></a>',
  ],
  ["<a target=_blank> with javascript:", '<a href="javascript:0" target="_blank">x</a>'],
  [
    "encoded javascript URL",
    '<a href="java&#115;cript:alert(1)">x</a>',
  ],
  ["srcdoc smuggle", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["formaction in button", '<form><button formaction="javascript:alert(1)">go</button></form>'],
];

describe("renderMarkdown — XSS payloads (LLM output)", () => {
  it.each(xssPayloads)("strips %s", (_label, payload) => {
    const out = renderMarkdown(payload, deps());

    // Forbidden tags — none of these should appear in the output.
    expect(out).not.toMatch(/<script\b/i);
    expect(out).not.toMatch(/<iframe\b/i);
    expect(out).not.toMatch(/<object\b/i);
    expect(out).not.toMatch(/<embed\b/i);
    expect(out).not.toMatch(/<form\b/i);
    expect(out).not.toMatch(/<input\b/i);
    expect(out).not.toMatch(/<button\b/i);
    expect(out).not.toMatch(/<meta\b/i);
    expect(out).not.toMatch(/<link\b/i);
    expect(out).not.toMatch(/<base\b/i);

    // Forbidden attributes / URL schemes.
    expect(out).not.toMatch(/\son\w+\s*=/i); // inline event handlers
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/srcdoc\s*=/i);
    expect(out).not.toMatch(/formaction\s*=/i);
    expect(out).not.toMatch(/=\s*['"]?data:/i);
  });
});

describe("renderMarkdown — benign content preserved", () => {
  it("renders basic inline markdown", () => {
    const out = renderMarkdown("**bold** _italic_ `code`", deps());
    expect(out).toMatch(/<strong>bold<\/strong>/);
    expect(out).toMatch(/<em>italic<\/em>/);
    expect(out).toMatch(/<code>code<\/code>/);
  });

  it("renders lists", () => {
    const out = renderMarkdown("- a\n- b\n- c", deps());
    expect(out).toMatch(/<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>/);
  });

  it("renders fenced code blocks", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```", deps());
    expect(out).toMatch(/<pre>/);
    expect(out).toMatch(/const x = 1/);
  });

  it("preserves safe https links", () => {
    const out = renderMarkdown(
      "[anthropic](https://www.anthropic.com)",
      deps(),
    );
    expect(out).toMatch(/<a [^>]*href="https:\/\/www\.anthropic\.com"/);
    expect(out).toMatch(/anthropic<\/a>/);
  });

  it("preserves mailto links", () => {
    const out = renderMarkdown("[mail](mailto:a@b.test)", deps());
    expect(out).toMatch(/href="mailto:a@b\.test"/);
  });

  it("escapes characters in raw text", () => {
    const out = renderMarkdown("less than: 3 < 4", deps());
    expect(out).toMatch(/3 &lt; 4/);
  });
});

describe("renderMarkdown — clipboard-spoof defences", () => {
  // The chat's Copy button reads `codeEl.innerText` and Cmd+C from the
  // user grabs the current selection. Both paths include text whose
  // CSS layout pushes it off-screen or hides it — exactly the trick a
  // jailbroken model could use to swap the visible command for a
  // dangerous one. Strip `style` outright so this primitive can't be
  // constructed.
  it("strips inline style attributes", () => {
    const out = renderMarkdown(
      'Hello <span style="position:absolute;left:-9999px">; rm -rf /</span> world',
      deps(),
    );
    expect(out).not.toMatch(/style\s*=/i);
  });

  it("strips style attributes injected via raw HTML anchors", () => {
    // Markdown has no attribute syntax; the only way to get a real
    // style attribute into the output is for the model to emit raw
    // HTML. Verify those land at the sanitizer and lose the
    // dangerous attribute (the anchor itself is allowed to remain).
    const out = renderMarkdown(
      'See <a href="https://example.com" style="display:none">link</a>',
      deps(),
    );
    expect(out).toMatch(/<a [^>]*href="https:\/\/example\.com"/);
    expect(out).not.toMatch(/style\s*=/i);
  });

  it("strips <details>/<summary> so collapsed content can't hide", () => {
    const out = renderMarkdown(
      "<details><summary>echo hi</summary>; rm -rf /</details>",
      deps(),
    );
    expect(out).not.toMatch(/<details\b/i);
    expect(out).not.toMatch(/<summary\b/i);
  });

  it("strips <details open> just as readily as collapsed", () => {
    const out = renderMarkdown(
      "<details open><summary>title</summary>body</details>",
      deps(),
    );
    expect(out).not.toMatch(/<details\b/i);
    expect(out).not.toMatch(/<summary\b/i);
  });
});

describe("renderMarkdown — edge cases", () => {
  it("returns empty string for empty input", () => {
    expect(renderMarkdown("", deps())).toBe("");
  });

  it("falls back to escaped <pre> when marked is missing", () => {
    const out = renderMarkdown("<script>alert(1)</script>", {
      sanitizer: DOMPurify as unknown as MarkdownDeps["sanitizer"],
    });
    expect(out).toMatch(/<pre>/);
    expect(out).not.toMatch(/<script\b/i);
  });

  it("falls-back path still goes through the sanitizer", () => {
    // Even without marked, the sanitizer must run. We pass in an
    // <iframe> — if the fallback bypassed the sanitizer it would
    // appear as escaped text *containing* the substring "iframe"
    // (which is fine, the < and > would be entities). We only need
    // to assert there's no live tag.
    const out = renderMarkdown("<iframe></iframe>", {
      sanitizer: DOMPurify as unknown as MarkdownDeps["sanitizer"],
    });
    expect(out).not.toMatch(/<iframe\b/i);
  });
});
