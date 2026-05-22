// IME composition tracker. macOS Japanese input fires Enter both to
// commit the composition AND (often) as a separate keystroke moments
// later. We need to suppress the *commit* Enter while still letting the
// *submit* Enter through. Different browsers signal this differently, so
// we layer four checks:
//
//   - an explicit composing flag toggled by compositionstart/end
//   - the keyboard event's own `isComposing`
//   - the legacy keyCode 229 ("IME in progress")
//   - a small post-compositionend grace window for browsers that fire
//     compositionend just before the keydown that triggered it

const POST_COMPOSITION_GRACE_MS = 50;

export interface ImeKeyEvent {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

export interface ImeTracker {
  onCompositionStart(): void;
  onCompositionEnd(): void;
  isBusy(e?: ImeKeyEvent | null): boolean;
}

export function createImeTracker(
  now: () => number = () => performance.now(),
): ImeTracker {
  let composing = false;
  let lastEndTime = 0;
  return {
    onCompositionStart() {
      composing = true;
    },
    onCompositionEnd() {
      composing = false;
      lastEndTime = now();
    },
    isBusy(e) {
      if (composing) return true;
      if (e && e.isComposing) return true;
      if (e && e.keyCode === 229) return true;
      // Only honour the post-compositionend grace window if we've actually
      // observed an end — otherwise the window erroneously triggers when
      // `now()` is small (relative to the default 0 sentinel).
      if (
        lastEndTime > 0 &&
        now() - lastEndTime < POST_COMPOSITION_GRACE_MS
      ) {
        return true;
      }
      return false;
    },
  };
}
