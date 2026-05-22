// Normalises one `claude --output-format stream-json` payload into the
// minimal event shape the chat UI needs to act on. Returning a typed kind
// keeps the call-site free of nested type checks and makes the logic
// testable without DOM.
//
// Returns null when the payload is irrelevant to the UI (system inits,
// rate-limit events, content_block_stop, message_delta, etc.).

export function parseClaudeEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = payload.type;

  if (type === "stream_event") {
    const ev = payload.event;
    if (!ev || typeof ev !== "object") return null;

    if (ev.type === "content_block_start") {
      const block = ev.content_block || {};
      if (block.type === "thinking") {
        return { kind: "thinking-start" };
      }
      return null;
    }

    if (ev.type === "content_block_delta") {
      const d = ev.delta || {};
      if (d.type === "thinking_delta") {
        return { kind: "thinking-delta", text: d.thinking || "" };
      }
      if (d.type === "text_delta") {
        return { kind: "text-delta", text: d.text || "" };
      }
      return null;
    }

    return null;
  }

  if (type === "result") {
    return {
      kind: "result",
      result: payload.result || "",
      isError: !!payload.is_error,
    };
  }

  if (type === "assistant") {
    const content = payload.message && payload.message.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c && c.type === "text")
        .map((c) => c.text || "")
        .join("");
      if (text) return { kind: "assistant-final", text };
    }
    return null;
  }

  return null;
}
