const SOFT_BREAK = '\uE000';

const BLOCK_TAGS = new Set([
	'ADDRESS',
	'ARTICLE',
	'ASIDE',
	'BLOCKQUOTE',
	'DD',
	'DIV',
	'DL',
	'DT',
	'FIELDSET',
	'FIGCAPTION',
	'FIGURE',
	'FOOTER',
	'FORM',
	'H1',
	'H2',
	'H3',
	'H4',
	'H5',
	'H6',
	'HEADER',
	'HR',
	'MAIN',
	'NAV',
	'P',
	'SECTION',
	'TABLE',
	'UL',
	'OL',
]);

const SKIP_TAGS = new Set(['BUTTON', 'SCRIPT', 'STYLE']);

// Surfaces whose own selection text should be copied natively (we bail out of
// custom normalization when the selection touches one). GFM task-list checkbox
// and radio inputs are excluded: they carry no copyable text and would
// otherwise suppress normalization for ordinary prose selections that happen to
// include a checklist item.
const NATIVE_COPY_SURFACE_SELECTOR =
	'pre, textarea, input:not([type="checkbox"]):not([type="radio"])';

function trimHorizontalEnd(text: string): string {
	return text.replace(/[ \t\u00a0]+$/g, '');
}

function serializeChildren(element: Element | DocumentFragment): string {
	return Array.from(element.childNodes).map(serializeRenderedChatNode).join('');
}

function parseIntAttribute(element: Element, attribute: string): number | null {
	const raw = element.getAttribute(attribute);
	if (raw === null || raw.trim() === '') return null;
	const value = Number(raw);
	return Number.isInteger(value) ? value : null;
}

function orderedListItemNumber(item: Element, list: Element): number {
	const explicit = parseIntAttribute(item, 'value');
	if (explicit !== null) return explicit;
	let ordinal = parseIntAttribute(list, 'start') ?? 1;
	for (const child of Array.from(list.children)) {
		if (child.tagName !== 'LI') continue;
		if (child === item) break;
		ordinal += 1;
	}
	return ordinal;
}

// Re-attach the list marker that CSS renders but textContent drops, so copied
// bullet, numbered, and task-list items keep their `- `, `1. `, `- [ ] `
// prefixes instead of collapsing into bare lines.
function listItemMarker(item: Element): string {
	if (item.classList.contains('task-list-item')) {
		const checkbox = item.querySelector('input[type="checkbox"]');
		const checked =
			checkbox instanceof HTMLInputElement
				? checkbox.checked
				: (checkbox?.hasAttribute('checked') ?? false);
		return checked ? '- [x] ' : '- [ ] ';
	}
	const list = item.parentElement;
	if (list && list.tagName === 'OL') {
		return `${orderedListItemNumber(item, list)}. `;
	}
	return '- ';
}

function serializeRenderedChatNode(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return (node.textContent ?? '').replace(/\n/g, SOFT_BREAK);
	}

	if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
		return serializeChildren(node as DocumentFragment);
	}

	if (node.nodeType !== Node.ELEMENT_NODE) {
		return '';
	}

	const element = node as HTMLElement;
	const tag = element.tagName;

	if (SKIP_TAGS.has(tag)) {
		return '';
	}

	if (tag === 'BR') {
		return SOFT_BREAK;
	}

	if (tag === 'IMG') {
		return element.getAttribute('alt') ?? '';
	}

	if (tag === 'PRE') {
		return `\n${element.textContent ?? ''}\n`;
	}

	if (tag === 'LI') {
		// Trim leading horizontal whitespace so the marker (e.g. "- [ ] ") does not
		// double up with the space that precedes task-list/inline content.
		const body = serializeChildren(element).replace(/^[ \t\u00a0]+/, '');
		return `${listItemMarker(element)}${trimHorizontalEnd(body)}\n`;
	}

	if (tag === 'TR') {
		return `${trimHorizontalEnd(serializeChildren(element))}\n`;
	}

	if (tag === 'TD' || tag === 'TH') {
		return `${serializeChildren(element).trim()}\t`;
	}

	const content = serializeChildren(element);
	if (BLOCK_TAGS.has(tag)) {
		return `${trimHorizontalEnd(content)}\n\n`;
	}

	return content;
}

function selectionIntersectsNativeCopySurface(range: Range, container: HTMLElement): boolean {
	const surfaces = [
		...(container.matches(NATIVE_COPY_SURFACE_SELECTOR) ? [container] : []),
		...Array.from(container.querySelectorAll(NATIVE_COPY_SURFACE_SELECTOR)),
	];

	return surfaces.some((surface) => range.intersectsNode(surface));
}

function rangeIsScopedToContainer(range: Range, container: HTMLElement): boolean {
	return container.contains(range.startContainer) && container.contains(range.endContainer);
}

function removeTrailingBoxBorder(text: string): string {
	return text.replace(/[ \t]*(?:[│┃║])?[ \t]*$/u, '');
}

function stripLeadingBoxBorder(text: string): string {
	return text.replace(/^[ \t]*(?:[│┃║][ \t]*)?/u, '');
}

function shouldJoinUrlSoftBreak(previousUrl: string, continuation: string): boolean {
	if (!continuation) return false;
	if (/^[/?#&=%.:~_-]/.test(continuation)) return true;
	if (!/^[A-Za-z0-9]/.test(continuation)) return false;
	return /[/?#&=%:~_-]$/.test(previousUrl);
}

function joinBrokenUrlsAcrossSoftBreaks(text: string): string {
	const parts = text.split(SOFT_BREAK);
	if (parts.length === 1) return text;

	let output = parts[0] ?? '';
	for (const part of parts.slice(1)) {
		const outputWithoutBox = removeTrailingBoxBorder(output);
		const previousUrl = outputWithoutBox.match(/((?:https?|ftp):\/\/[^\s│┃║]+)$/u)?.[1];
		const continuationText = stripLeadingBoxBorder(part);
		const continuationMatch = continuationText.match(/^([^\s│┃║]+)([\s\S]*)$/u);
		const continuation = continuationMatch?.[1] ?? '';

		if (previousUrl && continuation && shouldJoinUrlSoftBreak(previousUrl, continuation)) {
			output = `${outputWithoutBox}${continuation}${continuationMatch?.[2] ?? ''}`;
		} else {
			output += `${SOFT_BREAK}${part}`;
		}
	}

	return output;
}

export function normalizeRenderedChatCopy(text: string): string {
	const withJoinedUrls = joinBrokenUrlsAcrossSoftBreaks(
		text
			.replace(/\r\n?/g, '\n')
			.replace(/\u00a0/g, ' ')
			.replace(new RegExp(`${SOFT_BREAK}+`, 'g'), SOFT_BREAK)
	);

	return withJoinedUrls
		.replace(new RegExp(`[ \\t]*${SOFT_BREAK}[ \\t]*`, 'g'), ' ')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function serializeRenderedChatFragment(fragment: DocumentFragment): string {
	return serializeChildren(fragment);
}

export function getRenderedChatSelectionText(container: HTMLElement): string | null {
	const selection = window.getSelection?.();
	if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
		return null;
	}

	const range = selection.getRangeAt(0);
	if (!range.intersectsNode(container)) {
		return null;
	}

	if (!rangeIsScopedToContainer(range, container)) {
		return null;
	}

	if (selectionIntersectsNativeCopySurface(range, container)) {
		return null;
	}

	const common =
		range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? (range.commonAncestorContainer as Element)
			: range.commonAncestorContainer.parentElement;

	if (common?.closest(NATIVE_COPY_SURFACE_SELECTOR)) {
		return null;
	}

	const text = normalizeRenderedChatCopy(serializeRenderedChatFragment(range.cloneContents()));
	return text || null;
}

export function writeRenderedChatSelectionToClipboard(
	event: ClipboardEvent,
	container: HTMLElement
): boolean {
	if (event.defaultPrevented || !event.clipboardData) return false;

	const text = getRenderedChatSelectionText(container);
	if (!text) return false;

	event.clipboardData.setData('text/plain', text);
	event.preventDefault();
	return true;
}
