// Render Claude's markdown output to safe HTML.
//
// The model can produce arbitrary text — including jailbroken output or
// content sourced from a page the user pasted in. That text reaches this
// module, gets parsed by `marked` into HTML, and is then inserted into
// the chat bubble via `innerHTML`. Without sanitization, raw <script>,
// <iframe>, <img onerror=…>, javascript: URLs, etc. all become live in
// the WebView — and because the WebView has Tauri IPC access, that
// shape is closer to RCE than to self-XSS.
//
// The sanitizer (DOMPurify) is therefore THE trust boundary. Marked is
// a parser, not a security filter; never let its output reach the DOM
// without going through `sanitizer.sanitize()`.

export type MarkedLike = {
  parse(
    text: string,
    options?: { breaks?: boolean; gfm?: boolean },
  ): string;
};

export type SanitizerHookFn = (
  node: Element,
  data?: unknown,
  config?: unknown,
) => void;

export type SanitizerLike = {
  sanitize(html: string, config?: Record<string, unknown>): string;
  addHook?(name: string, cb: SanitizerHookFn): void;
};

export interface MarkdownDeps {
  /** Optional: when missing we fall back to an escaped <pre> block. */
  marked?: MarkedLike;
  sanitizer: SanitizerLike;
}

/**
 * DOMPurify config tightened beyond its defaults.
 *
 * We forbid every tag we have no business rendering inside a chat
 * bubble (forms, frames, embedded objects, style/link/meta/base) and
 * narrow ALLOWED_URI_REGEXP to the handful of schemes a chat reply
 * could legitimately need. Anything else is dropped.
 */
function sanitizerConfig(): Record<string, unknown> {
  return {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "meta",
      "link",
      "base",
      "frame",
      "frameset",
      // <details>/<summary> let the model collapse text so it's
      // invisible on screen but still present in textContent — a
      // clipboard-spoofing primitive when the user select-copies what
      // they think is benign output. No marked output uses these tags;
      // forbid them entirely.
      "details",
      "summary",
    ],
    FORBID_ATTR: [
      "formaction",
      "srcdoc",
      "srcset",
      "background",
      // Inline `style` lets the model hide text off-screen
      // (`position:absolute;left:-9999px`) or paint it invisible
      // (`opacity:0`, `font-size:0`). The hidden text remains in
      // `innerText` and in select-copy selections — perfect for
      // spoofing what the user thinks they're copying. Strip every
      // inline style so the only thing the user can copy is what
      // they can see.
      "style",
    ],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
    ALLOW_DATA_ATTR: false,
  };
}

// DOMPurify special-cases data: URLs in <img>/<audio>/<video>/<source>/
// <track> and lets them through regardless of ALLOWED_URI_REGEXP
// (DATA_URI_TAGS in its source). data:image/svg+xml can carry executable
// script, so we must strip data: URLs ourselves via a hook.
//
// Hooks are registered on the DOMPurify singleton, so guard with a
// module-level flag to keep us idempotent across re-imports and repeated
// renderMarkdown() calls.
let hooksInstalled = false;

function installSecurityHooks(sanitizer: SanitizerLike): void {
  if (hooksInstalled) return;
  if (typeof sanitizer.addHook !== "function") return;
  hooksInstalled = true;

  sanitizer.addHook("afterSanitizeAttributes", (node: Element) => {
    if (typeof node.getAttribute !== "function") return;

    // Drop data: URLs from every URL-bearing attribute. We can't rely
    // on the schema regex for these because DOMPurify whitelists
    // data: in DATA_URI_TAGS.
    for (const attr of [
      "src",
      "href",
      "xlink:href",
      "poster",
      "data",
      "action",
    ]) {
      const v = node.getAttribute(attr);
      if (v && /^\s*data:/i.test(v)) {
        node.removeAttribute(attr);
      }
    }

    // Auto-add rel=noopener noreferrer to any anchor that opens a new
    // context, even though we don't expect target= in chat content.
    // Cheap insurance against reverse-tabnabbing.
    if (
      node.tagName === "A" &&
      node.hasAttribute &&
      node.hasAttribute("target")
    ) {
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Parse markdown and return sanitized HTML safe for `innerHTML`.
 *
 * Fallback path (marked missing): HTML-escape the text and wrap in
 * <pre>, then still run it through the sanitizer. Callers always
 * assume the return value is safe to set as innerHTML and we must not
 * break that invariant on the failure path either.
 */
export function renderMarkdown(text: string, deps: MarkdownDeps): string {
  if (!text) return "";
  installSecurityHooks(deps.sanitizer);
  const raw = deps.marked
    ? deps.marked.parse(text, { breaks: true, gfm: true })
    : `<pre>${escapeHtml(text)}</pre>`;
  return deps.sanitizer.sanitize(raw, sanitizerConfig());
}

/**
 * Test-only escape hatch: reset the hook-installed flag so a test can
 * re-install hooks on a fresh DOMPurify instance. Not exported in the
 * public surface of the app.
 */
export function __resetHooksForTesting(): void {
  hooksInstalled = false;
}
