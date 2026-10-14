/**
 * Pointer to device-screen mapping (WU-05, WU-06).
 *
 * The canvas element can be larger than the picture it shows: `object-fit: contain`
 * letterboxes (or pillarboxes) the video inside the element box. Normalised input
 * coordinates must be computed over the drawn picture, not over the element.
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ContentSize {
  width: number;
  height: number;
}

/** The rectangle the picture actually occupies inside `rect` with object-fit: contain. */
export function containedContentBox(rect: RectLike, content: ContentSize | null): RectLike {
  if (!content || content.width <= 0 || content.height <= 0 || rect.width <= 0 || rect.height <= 0) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  const scale = Math.min(rect.width / content.width, rect.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

export interface MappedPoint {
  /** 0..1 across the device screen (clamped when `clamp` is set). */
  x: number;
  y: number;
  /** False when the point is in the letterbox bars (or outside the element). */
  inside: boolean;
}

/**
 * Map a client point to normalised device-screen coordinates.
 * `content` is the current device screen size (SCREEN_INFO), which already reflects
 * rotation; with no known size the whole element box is used.
 */
export function mapPointToContent(
  clientX: number,
  clientY: number,
  rect: RectLike,
  content: ContentSize | null,
  clamp = false
): MappedPoint {
  const box = containedContentBox(rect, content);
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0, inside: false };
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  const eps = 1e-9;
  const inside = x >= -eps && x <= 1 + eps && y >= -eps && y <= 1 + eps;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return clamp || inside ? { x: c(x), y: c(y), inside } : { x, y, inside };
}
