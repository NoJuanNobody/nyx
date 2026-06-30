import { useCallback, useRef } from 'react';

interface LongPressOptions {
  /** Duration in ms before the long-press fires. Default: 500 */
  threshold?: number;
}

/**
 * Returns touch event handlers that fire `callback` after the pointer has been
 * held still for `threshold` milliseconds. Moving or lifting the finger cancels
 * the timer, so normal taps and scrolls are unaffected.
 *
 * Spread the returned object onto any React element:
 *   `<div {...longPressProps} />`
 */
export function useLongPress(
  callback: (e: React.TouchEvent) => void,
  options: LongPressOptions = {},
) {
  const { threshold = 500 } = options;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(
    (e: React.TouchEvent) => {
      // Prevent the browser's native long-press context menu / text-selection
      e.preventDefault();
      timerRef.current = setTimeout(() => {
        callback(e);
      }, threshold);
    },
    [callback, threshold],
  );

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return {
    onTouchStart: start,
    onTouchEnd: cancel,
    onTouchMove: cancel,
    onTouchCancel: cancel,
  };
}
