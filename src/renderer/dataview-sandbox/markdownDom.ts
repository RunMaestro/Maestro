/**
 * The DataviewJS guest's markdown step (D6): markdown to DOM nodes, built with `createElement` and
 * `textContent` only. markdown-it runs with `html: false`, so raw HTML in a note arrives as text, and no
 * HTML string ever reaches the DOM (no `innerHTML`, no `md.render()`). There is nothing to sanitize: a
 * `<script>` element or an `onerror` attribute in a value renders as the characters it is.
 *
 * Links never navigate the guest. A wiki link (`[[x]]`, `![[x]]`) or a relative markdown link names a vault
 * file and an http or https link names a page; the caller turns each into an anchor whose click sends
 * `open.link`. Links with any other scheme render as their text. Images load only from `data:` (the guest
 * CSP's `img-src`); any other image renders as a link to its target.
 */

import MarkdownIt from 'markdown-it';
import { WIKI_LINK_PATTERN } from '../../shared/fileLinkPatterns';
import { mayContainMarkdown } from '../../shared/dataview';

type Token = ReturnType<MarkdownIt['parse']>[number];
type InlineRule = Parameters<MarkdownIt['inline']['ruler']['before']>[2];

/** Where the links in a markdown string point. Each method returns an empty anchor; the label is added here. */
export interface MarkdownLinks {
	/** A vault link: `[[target]]`, `![[target]]`, or a relative markdown link, with `linkpath` as written. */
	vaultLink(linkpath: string, embed: boolean): HTMLElement;
	/** An http or https link. */
	urlLink(url: string): HTMLElement;
}

/** The wiki link token the inline rule below emits. */
const WIKI_LINK_TOKEN = 'dataview_wikilink';

interface WikiLinkMeta {
	embed: boolean;
	target: string;
	display: string | undefined;
}

/** `[[...]]` and `![[...]]` at one position, in the grammar the preview and the index use. */
const WIKI_LINK_AT = new RegExp(`(!?)${WIKI_LINK_PATTERN.source}`, 'y');

/**
 * Read a wiki link before markdown-it's own link and emphasis rules see its brackets, so `[[a*b*]]` stays
 * one link instead of turning into emphasis inside text.
 */
const wikiLinkRule: InlineRule = (state, silent) => {
	const first = state.src.charCodeAt(state.pos);
	if (first !== 0x5b /* [ */ && first !== 0x21 /* ! */) return false;
	WIKI_LINK_AT.lastIndex = state.pos;
	const match = WIKI_LINK_AT.exec(state.src);
	if (!match || state.pos + match[0].length > state.posMax) return false;
	if (!silent) {
		const token = state.push(WIKI_LINK_TOKEN, '', 0);
		const meta: WikiLinkMeta = { embed: match[1] === '!', target: match[2], display: match[3] };
		token.meta = meta;
	}
	state.pos += match[0].length;
	return true;
};

// `html: false` is the XSS boundary; `linkify` makes bare URLs links, as Obsidian and the preview's Fast
// tier do (`src/renderer/components/FilePreview/markdownFast/parser.ts`).
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
md.inline.ruler.before('link', WIKI_LINK_TOKEN, wikiLinkRule);

/** Block elements markdown-it emits with `html: false`. Anything else becomes a `div`. */
const BLOCK_TAGS = new Set([
	'p',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'blockquote',
	'ul',
	'ol',
	'li',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
]);

/** Inline elements markdown-it emits for emphasis. Anything else becomes a `span`. */
const INLINE_TAGS = new Set(['em', 'strong', 's']);

const CELL_ALIGNMENT = /^text-align:(left|center|right)$/;

function blockElement(doc: Document, token: Token): HTMLElement {
	const element = doc.createElement(BLOCK_TAGS.has(token.tag) ? token.tag : 'div');
	const start = token.attrGet('start');
	if (token.tag === 'ol' && start !== null && /^\d{1,9}$/.test(start)) {
		element.setAttribute('start', start);
	}
	const alignment = CELL_ALIGNMENT.exec(token.attrGet('style') ?? '');
	if (alignment) element.style.textAlign = alignment[1];
	return element;
}

/** A markdown link's target: an http or https URL, a vault path, or nothing it may open. */
function linkTarget(
	href: string
): { kind: 'url'; url: string } | { kind: 'vault'; linkpath: string } | null {
	if (/^https?:\/\//i.test(href)) return { kind: 'url', url: href };
	// Another scheme (`mailto:`, `obsidian:`), a protocol-relative URL, or an in-page anchor.
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#'))
		return null;
	const linkpath = md.normalizeLinkText(href);
	return linkpath ? { kind: 'vault', linkpath } : null;
}

function linkElement(doc: Document, href: string, links: MarkdownLinks): HTMLElement {
	const target = linkTarget(href);
	if (!target) return doc.createElement('span');
	return target.kind === 'url'
		? links.urlLink(target.url)
		: links.vaultLink(target.linkpath, false);
}

function imageElement(doc: Document, token: Token, links: MarkdownLinks): HTMLElement {
	const src = token.attrGet('src') ?? '';
	if (/^data:image\//i.test(src)) {
		const image = doc.createElement('img');
		image.setAttribute('src', src);
		image.setAttribute('alt', token.content);
		return image;
	}
	const link = linkElement(doc, src, links);
	link.append(token.content || md.normalizeLinkText(src));
	return link;
}

function renderInline(container: Node, tokens: Token[], links: MarkdownLinks): void {
	const doc = container.ownerDocument as Document;
	const stack: Node[] = [container];
	for (const token of tokens) {
		const parent = stack[stack.length - 1];
		switch (token.type) {
			case 'text':
				parent.appendChild(doc.createTextNode(token.content));
				break;
			case 'softbreak':
				parent.appendChild(doc.createTextNode('\n'));
				break;
			case 'hardbreak':
				parent.appendChild(doc.createElement('br'));
				break;
			case 'code_inline': {
				const code = doc.createElement('code');
				code.textContent = token.content;
				parent.appendChild(code);
				break;
			}
			case 'em_open':
			case 'strong_open':
			case 's_open': {
				const element = doc.createElement(INLINE_TAGS.has(token.tag) ? token.tag : 'span');
				parent.appendChild(element);
				stack.push(element);
				break;
			}
			case 'link_open': {
				const element = linkElement(doc, token.attrGet('href') ?? '', links);
				parent.appendChild(element);
				stack.push(element);
				break;
			}
			case 'em_close':
			case 'strong_close':
			case 's_close':
			case 'link_close':
				if (stack.length > 1) stack.pop();
				break;
			case 'image':
				parent.appendChild(imageElement(doc, token, links));
				break;
			case WIKI_LINK_TOKEN: {
				const meta = token.meta as WikiLinkMeta;
				const element = links.vaultLink(meta.target, meta.embed);
				element.append(meta.display ?? meta.target);
				parent.appendChild(element);
				break;
			}
			default:
				// `html_inline` cannot occur with `html: false`; anything unknown keeps its text.
				if (token.content) parent.appendChild(doc.createTextNode(token.content));
		}
	}
}

/** Render `markdown` into `container` as DOM nodes. */
export function renderMarkdown(
	container: HTMLElement,
	markdown: string,
	links: MarkdownLinks
): void {
	const doc = container.ownerDocument;
	const stack: Node[] = [container];
	for (const token of md.parse(markdown, {})) {
		const parent = stack[stack.length - 1];
		if (token.nesting === 1) {
			// A tight list hides its paragraphs: their text goes straight into the list item.
			const element = token.hidden ? parent : blockElement(doc, token);
			if (element !== parent) parent.appendChild(element);
			stack.push(element);
		} else if (token.nesting === -1) {
			if (stack.length > 1) stack.pop();
		} else if (token.type === 'inline') {
			renderInline(parent, token.children ?? [], links);
		} else if (token.type === 'fence' || token.type === 'code_block') {
			const pre = doc.createElement('pre');
			const code = doc.createElement('code');
			code.textContent = token.content;
			pre.appendChild(code);
			parent.appendChild(pre);
		} else if (token.type === 'hr') {
			parent.appendChild(doc.createElement('hr'));
		} else if (token.content) {
			// `html_block` cannot occur with `html: false`; anything unknown keeps its text.
			parent.appendChild(doc.createTextNode(token.content));
		}
	}
}

/**
 * Upstream `renderCompactMarkdown` (`ui/render.ts`): the markdown in a new span inside `container`, with a
 * lone paragraph unwrapped so one line of text stays inline. Plain text skips the parse.
 */
export function renderCompactMarkdown(
	container: HTMLElement,
	markdown: string,
	links: MarkdownLinks
): HTMLSpanElement {
	const span = container.ownerDocument.createElement('span');
	container.appendChild(span);
	if (!mayContainMarkdown(markdown)) {
		span.textContent = markdown;
		return span;
	}
	renderMarkdown(span, markdown, links);
	const paragraph = span.firstElementChild;
	if (span.children.length === 1 && paragraph?.tagName === 'P') {
		while (paragraph.firstChild) span.appendChild(paragraph.firstChild);
		paragraph.remove();
	}
	return span;
}
