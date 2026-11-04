/**
 * Measure where a character index sits inside a textarea, using an off-screen
 * mirror element that copies the textarea's text metrics. Used to anchor the
 * slash/mention palette and the selection toolbar at the actual caret/selection
 * instead of the textarea box.
 */
const MIRRORED = [
  'boxSizing', 'width', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontFamily',
  'lineHeight', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing',
  'tabSize',
] as const;

export interface CaretPoint {
  /** Viewport coordinates. */
  top: number;
  left: number;
  height: number;
}

export function getCaretPoint(ta: HTMLTextAreaElement, index: number): CaretPoint {
  const box = ta.getBoundingClientRect();
  const style = window.getComputedStyle(ta);
  const lineHeight = parseFloat(style.lineHeight) || 22;

  const mirror = document.createElement('div');
  const ms = mirror.style;
  ms.position = 'absolute';
  ms.visibility = 'hidden';
  ms.top = '0';
  ms.left = '-9999px';
  ms.whiteSpace = 'pre-wrap';
  ms.wordWrap = 'break-word';
  for (const prop of MIRRORED) {
    (ms as unknown as Record<string, string>)[prop] = style[prop];
  }
  mirror.textContent = ta.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = ta.value.slice(index) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  document.body.removeChild(mirror);

  return {
    top: box.top + top - ta.scrollTop,
    left: box.left + left - ta.scrollLeft,
    height: lineHeight,
  };
}

/** Bounding rect (viewport) of the current selection inside a textarea. */
export function getSelectionRect(ta: HTMLTextAreaElement): DOMRect {
  const a = getCaretPoint(ta, ta.selectionStart);
  const b = getCaretPoint(ta, ta.selectionEnd);
  const box = ta.getBoundingClientRect();
  const sameLine = Math.abs(a.top - b.top) < 1;
  const left = sameLine ? Math.min(a.left, b.left) : box.left;
  const width = sameLine ? Math.abs(b.left - a.left) : box.width;
  return new DOMRect(left, a.top, width, Math.max(a.height, b.top - a.top + b.height));
}
