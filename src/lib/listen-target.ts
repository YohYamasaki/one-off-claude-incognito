// Build the `target` option that pins a `listen()` call to a single
// webview's IPC channel.
//
// Why this exists as its own module (rather than an inline object
// literal in chat.ts): the SHAPE of this object is half of a
// load-bearing contract that crosses the JS/Rust boundary. The Rust
// side calls `app.emit_to(label, …)`, which Tauri turns into an
// `EventTarget::AnyLabel{label}` and routes via `filter_target`. That
// filter only matches listener targets that carry the same `label` AND
// are of kind `Window`, `Webview`, `WebviewWindow`, or `AnyLabel` —
// notably NOT `Any` (the default when you call `listen(event, handler)`
// without an options object).
//
// Get either half wrong and the chat windows leak each other's deltas:
//   - Rust uses `webview.emit(…)` (broadcast)  → leaks regardless of
//     listener target.
//   - JS uses `listen(event, handler)` with no opts → target is `Any`,
//     never matched by `emit_to`.
//
// Keep this function in lockstep with `app.emit_to(label, …)` in
// `src-tauri/src/chat.rs`. The test below locks the shape.

export interface ListenTargetOptions {
  target: { kind: "WebviewWindow"; label: string };
}

export function makeListenTarget(windowLabel: string): ListenTargetOptions {
  return { target: { kind: "WebviewWindow", label: windowLabel } };
}
