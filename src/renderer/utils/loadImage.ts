/**
 * loadImage - Decode an image source into a ready-to-draw `HTMLImageElement`.
 *
 * Every canvas-compositing path in the renderer (annotator composite, annotator
 * crop, image export) needs the same three lines: make an `Image`, await
 * `onload`, reject on `onerror`. Keeping one copy means a source that never
 * resolves fails the same way everywhere instead of hanging one caller and
 * throwing in another.
 *
 * Accepts anything an `<img src>` accepts - a data URL, a `maestro-image://`
 * store reference, a `file://` path, or a remote URL. The returned element is
 * decoded, so `naturalWidth` / `naturalHeight` are safe to read immediately.
 */

export function loadImageElement(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load image'));
		img.src = src;
	});
}

export default loadImageElement;
