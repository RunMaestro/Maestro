/**
 * Pure DOM helpers shared by every FilePreview tier that needs to land the
 * viewport on a matched word (not just the matched block / page).
 *
 * Why shared:
 *   The markdown Fast tier (Virtuoso blocks), text Fast tier (TanStack Virtual
 *   pages), and any future tier all need the same primitive - given a mounted
 *   container element + a character offset + a length, build a DOM `Range`
 *   over exactly those characters and scroll it into view. The only per-tier
 *   difference is which selector locates the container; each tier handles
 *   that locally.
 *
 * No React, no virtualizer internals - just standard DOM APIs.
 */

/**
 * Walk text nodes inside `containerEl` to build a `Range` that spans
 * `length` characters starting at `offsetWithinContainer`. Handles matches
 * that cross inline element boundaries (rare but valid - e.g. a search
 * query that spans a `<strong>` boundary or a Shiki-emitted `<span>`).
 *
 * Returns `null` when the offset is past the end of the container's text
 * content, which can happen when the search engine and the DOM diverge
 * (e.g. a sanitizer stripped some content). Callers should treat null as
 * "no precise target, fall back to container-level scroll".
 */
export function buildRangeAtOffset(
	containerEl: HTMLElement,
	offsetWithinContainer: number,
	length: number
): Range | null {
	if (offsetWithinContainer < 0 || length < 0) return null;
	const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
	let consumed = 0;
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const textNode = node as Text;
		const nodeLen = (textNode.textContent ?? '').length;
		if (consumed + nodeLen > offsetWithinContainer) {
			const startOffsetInNode = offsetWithinContainer - consumed;
			const range = document.createRange();
			range.setStart(textNode, startOffsetInNode);

			// Match fits in the start node - single-node range, done.
			if (startOffsetInNode + length <= nodeLen) {
				range.setEnd(textNode, startOffsetInNode + length);
				return range;
			}

			// Multi-node range: keep walking until we've consumed `length` more
			// characters from where the start node ended. Track the last text
			// node we visit so the fallback clamp lands on the end of the
			// LAST traversed node (not the start node).
			let remaining = length - (nodeLen - startOffsetInNode);
			let lastTextNode: Text = textNode;
			let lastNodeLen: number = nodeLen;
			while ((node = walker.nextNode())) {
				const nextNode = node as Text;
				const nextLen = (nextNode.textContent ?? '').length;
				if (nextLen >= remaining) {
					range.setEnd(nextNode, remaining);
					return range;
				}
				remaining -= nextLen;
				lastTextNode = nextNode;
				lastNodeLen = nextLen;
			}

			// Ran out of text before satisfying `length` - clamp end to the
			// last node end. Caller still gets a usable range starting at the
			// right position for scroll purposes.
			range.setEnd(lastTextNode, lastNodeLen);
			return range;
		}
		consumed += nodeLen;
	}
	return null;
}

/**
 * Scroll the nearest ancestor of `range.startContainer` into view if needed,
 * so the matched word becomes visible. Uses `scrollIntoView({ block: 'nearest' })`
 * which is a no-op when the element is already visible - that keeps the
 * higher-level virtualizer scroll (Virtuoso `scrollToIndex`) from being
 * disturbed when the match is already centered.
 *
 * Returns true when a scroll target was found, false otherwise.
 */
export function scrollRangeIntoView(range: Range | null): boolean {
	if (!range) return false;
	const startNode = range.startContainer;
	const targetEl =
		startNode.nodeType === Node.TEXT_NODE
			? (startNode as Text).parentElement
			: (startNode as Element);
	if (!targetEl) return false;
	targetEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
	return true;
}
