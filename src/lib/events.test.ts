import { describe, it, expect } from "vitest";
import { parseClaudeEvent } from "./events";

describe("parseClaudeEvent", () => {
  it("returns null for falsy or non-object payloads", () => {
    expect(parseClaudeEvent(null)).toBeNull();
    expect(parseClaudeEvent(undefined)).toBeNull();
    expect(parseClaudeEvent("string")).toBeNull();
    expect(parseClaudeEvent(42)).toBeNull();
  });

  it("returns null for system init / unknown event types", () => {
    expect(parseClaudeEvent({ type: "system", subtype: "init" })).toBeNull();
    expect(parseClaudeEvent({ type: "rate_limit_event" })).toBeNull();
    expect(parseClaudeEvent({ type: "unknown-future-event" })).toBeNull();
  });

  describe("stream_event content_block_delta", () => {
    it("decodes text_delta into a text-delta", () => {
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
        }),
      ).toEqual({ kind: "text-delta", text: "Hi" });
    });

    it("decodes thinking_delta into a thinking-delta", () => {
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "pondering" },
          },
        }),
      ).toEqual({ kind: "thinking-delta", text: "pondering" });
    });

    it("preserves multi-byte UTF-8 text faithfully", () => {
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "こんにちは 🌸" },
          },
        }),
      ).toEqual({ kind: "text-delta", text: "こんにちは 🌸" });
    });

    it("substitutes empty string for missing text fields", () => {
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta" } },
        }),
      ).toEqual({ kind: "text-delta", text: "" });
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "thinking_delta" } },
        }),
      ).toEqual({ kind: "thinking-delta", text: "" });
    });

    it("returns null for unknown delta types (e.g. tool_use_delta)", () => {
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "tool_use_delta" } },
        }),
      ).toBeNull();
    });

    it("returns null when the event payload is malformed", () => {
      expect(parseClaudeEvent({ type: "stream_event", event: null })).toBeNull();
      expect(parseClaudeEvent({ type: "stream_event", event: "oops" })).toBeNull();
    });
  });

  describe("stream_event content_block_start", () => {
    it("flags the start of a thinking block", () => {
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "thinking" } },
        }),
      ).toEqual({ kind: "thinking-start" });
    });

    it("returns null for non-thinking block starts (text, tool_use, ...)", () => {
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "text" } },
        }),
      ).toBeNull();
      expect(
        parseClaudeEvent({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "tool_use" } },
        }),
      ).toBeNull();
    });
  });

  it("ignores content_block_stop, message_delta, message_stop", () => {
    expect(
      parseClaudeEvent({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    ).toBeNull();
    expect(
      parseClaudeEvent({ type: "stream_event", event: { type: "message_delta", delta: {} } }),
    ).toBeNull();
    expect(
      parseClaudeEvent({ type: "stream_event", event: { type: "message_stop" } }),
    ).toBeNull();
  });

  describe("result", () => {
    it("extracts result text and the error flag", () => {
      expect(
        parseClaudeEvent({ type: "result", result: "all good", is_error: false }),
      ).toEqual({ kind: "result", result: "all good", isError: false });
    });

    it("coerces truthy is_error to boolean true", () => {
      expect(parseClaudeEvent({ type: "result", result: "!", is_error: "yes" })).toEqual({
        kind: "result",
        result: "!",
        isError: true,
      });
    });

    it("treats missing result text as an empty string", () => {
      expect(parseClaudeEvent({ type: "result" })).toEqual({
        kind: "result",
        result: "",
        isError: false,
      });
    });
  });

  describe("assistant (final message)", () => {
    it("concatenates text content blocks into the final text", () => {
      expect(
        parseClaudeEvent({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Hello" },
              { type: "text", text: " world" },
            ],
          },
        }),
      ).toEqual({ kind: "assistant-final", text: "Hello world" });
    });

    it("ignores non-text content blocks (thinking, tool_use, ...)", () => {
      expect(
        parseClaudeEvent({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "answer" },
            ],
          },
        }),
      ).toEqual({ kind: "assistant-final", text: "answer" });
    });

    it("returns null when the message has no text blocks at all", () => {
      expect(
        parseClaudeEvent({
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "x" }] },
        }),
      ).toBeNull();
    });

    it("returns null when the content shape is malformed", () => {
      expect(parseClaudeEvent({ type: "assistant", message: {} })).toBeNull();
      expect(parseClaudeEvent({ type: "assistant" })).toBeNull();
    });
  });
});
