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

function trimHorizontalEnd(text: string): string {
	return text.replace(/[ \t\u00a0]+$/g, '');
}

function serializeChildren(element: Element | DocumentFragment): string {
	return Array.from(element.childNodes).map(serializeRenderedChatNode).join('');
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
		return `${trimHorizontalEnd(serializeChildren(element))}\n`;
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
		...(container.matches('pre, textarea, input') ? [container] : []),
		...Array.from(container.querySelectorAll('pre, textarea, input')),
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
		.replace(/[ \t]{2,}/g, ' ')
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

	if (common?.closest('pre, textarea, input')) {
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
