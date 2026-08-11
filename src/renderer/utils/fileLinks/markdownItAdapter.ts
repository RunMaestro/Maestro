import type MarkdownIt from 'markdown-it';
import {
	findClosestMatch,
	toRelativePath,
	validatePathReference,
	type FileTreeIndices,
} from './matcher';
import {
	IMAGE_EMBED_PATTERN,
	MAESTRO_DEEP_LINK_PATTERN,
	PATH_PATTERN,
	WIKI_LINK_PATTERN,
} from './patterns';

type ParserToken = ReturnType<MarkdownIt['parse']>[number];

/**
 * Options for the markdown-it file-link adapter. Mirrors RemarkFileLinksOptions
 * (in remarkFileLinks.ts) so callers can use either tier with the same config.
 *
 * Use pre-built indices for performance - `FilePreview` already memoizes
 * `buildFileTreeIndices(fileTree)` so the Fast tier inherits zero extra cost.
 */
export interface MarkdownItFileLinksOptions {
	indices?: FileTreeIndices;
	cwd?: string;
	projectRoot?: string;
	homeDir?: string;
}

/**
 * Apply file-link resolution to a markdown-it token stream in place.
 *
 * Two passes:
 *   1. `link_open` href rewriter - converts `[label](path)` to `maestro-file://`
 *      when `path` resolves in the file tree. Adds `data-maestro-file` for
 *      DOMPurify-safe carriage of the resolved path.
 *   2. `inline` text rewriter - splits text children on `![[…]]` / `[[…]]`
 *      patterns and replaces them with synthetic `image`/`link_open` tokens.
 *
 * Pure (no DOM, no network). Mirrors the Rich-tier remarkFileLinks behavior
 * so resolution is byte-for-byte identical across tiers.
 */
export function applyFileLinks(
	md: MarkdownIt,
	tokens: ParserToken[],
	options: MarkdownItFileLinksOptions
): void {
	const indices = options.indices ?? {
		allPaths: new Set<string>(),
		filenameIndex: new Map<string, string[]>(),
	};
	const cwd = options.cwd ?? '';

	rewriteStandardLinks(tokens, indices, cwd, options.projectRoot, options.homeDir);
	rewriteInlineWikiAndImageEmbeds(md, tokens, indices, cwd);
}

// ─── Pass 1: standard markdown link href rewriting ───────────────────────────

function rewriteStandardLinks(
	tokens: ParserToken[],
	indices: FileTreeIndices,
	cwd: string,
	projectRoot: string | undefined,
	homeDir: string | undefined
): void {
	for (const token of tokens) {
		// Recurse into inline tokens' children to catch links nested inside
		// paragraphs/list items/etc.
		if (token.type === 'inline' && token.children) {
			rewriteStandardLinks(token.children, indices, cwd, projectRoot, homeDir);
			continue;
		}
		if (token.type !== 'link_open') continue;

		const hrefAttr = token.attrGet('href');
		if (!hrefAttr) continue;

		// Skip already-rewritten and out-of-scope hrefs.
		if (
			hrefAttr.startsWith('maestro-file://') ||
			hrefAttr.startsWith('maestro://') ||
			hrefAttr.startsWith('http://') ||
			hrefAttr.startsWith('https://') ||
			hrefAttr.startsWith('mailto:') ||
			hrefAttr.startsWith('tel:') ||
			hrefAttr.startsWith('file://') ||
			hrefAttr.startsWith('#')
		) {
			continue;
		}

		const decoded = safeDecode(hrefAttr);
		let resolved: string | null = null;

		if (projectRoot && decoded.startsWith('/')) {
			resolved = toRelativePath(decoded, projectRoot);
		}
		if (!resolved && homeDir && decoded.startsWith('~/')) {
			const absolute = homeDir + decoded.slice(1);
			const relative = toRelativePath(absolute, projectRoot);
			if (relative) {
				resolved = relative;
			} else {
				// Outside projectRoot - emit a file:// URL so the click handler can
				// hand it to shell.openPath.
				token.attrSet('href', `file://${absolute}`);
				continue;
			}
		}
		if (!resolved) {
			resolved = findClosestMatch(decoded, indices, cwd);
		}
		if (!resolved) continue;

		token.attrSet('href', `maestro-file://${resolved}`);
		token.attrSet('data-maestro-file', resolved);
	}
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch (err) {
		// Only swallow URIError (malformed percent-encoding, e.g. "%E0%A4%A").
		// Any other error is unexpected and should surface - masking it would
		// hide bugs (out-of-memory, polyfill regressions, etc.).
		if (err instanceof URIError) return s;
		throw err;
	}
}

// ─── Pass 2: inline [[wiki]] and ![[image]] rewriting ─────────────────────────
//
// markdown-it represents inline content as an `inline` token whose `children`
// array contains a mix of text/em/strong/link tokens. We scan each text-typed
// child for wiki and image-embed patterns and replace it with a synthetic
// sequence of (text, link_open, text, link_close, ...) tokens that point at
// `maestro-file://` and carry the same `data-maestro-file` attribute the click
// router prefers.

function rewriteInlineWikiAndImageEmbeds(
	md: MarkdownIt,
	tokens: ParserToken[],
	indices: FileTreeIndices,
	cwd: string
): void {
	for (const token of tokens) {
		if (token.type !== 'inline' || !token.children) continue;

		const rewritten: ParserToken[] = [];
		// Track nesting inside `<a>` so we don't rewrite the label text of an
		// existing link (e.g. `[some src/x.ts text](url)`) - that would produce
		// nested anchors, which is invalid HTML and breaks the parent link's
		// click handling. The Rich-tier remarkFileLinks plugin already skips
		// link descendants; this keeps Fast tier behavior in lockstep.
		let inLink = 0;
		for (const child of token.children) {
			if (child.type === 'link_open') {
				inLink++;
				rewritten.push(child);
				continue;
			}
			if (child.type === 'link_close') {
				inLink = Math.max(0, inLink - 1);
				rewritten.push(child);
				continue;
			}
			if (child.type !== 'text' || inLink > 0) {
				rewritten.push(child);
				continue;
			}

			const expanded = expandTextToken(md, child, indices, cwd);
			if (expanded === null) {
				rewritten.push(child);
			} else {
				rewritten.push(...expanded);
			}
		}
		token.children = rewritten;
	}
}

interface InlineMatch {
	start: number;
	end: number;
	kind: 'wiki' | 'image' | 'deep-link';
	/** For wiki/image: relative path resolved against the file tree. For deep-link: the full `maestro://` URL. */
	resolvedPath: string;
	display: string;
	imageWidth?: number;
}

/**
 * Scan the text content of a single text token for wiki/image patterns.
 * Returns null when the text has no matches (caller keeps the original
 * token) or an expanded token sequence to splice in.
 */
function expandTextToken(
	_md: MarkdownIt,
	token: ParserToken,
	indices: FileTreeIndices,
	cwd: string
): ParserToken[] | null {
	const text = token.content;
	if (!text) return null;

	const matches = collectInlineMatches(text, indices, cwd);
	if (matches.length === 0) return null;

	const out: ParserToken[] = [];
	let cursor = 0;
	// markdown-it does not export the Token class on the public surface, so we
	// reuse the constructor from the text token we already have. Every parser
	// token is an instance of the same class, so this is safe.
	const TokenCtor = token.constructor as new (
		type: string,
		tag: string,
		nesting: number
	) => ParserToken;
	const newToken = (type: string, tag: string, nesting: number): ParserToken =>
		new TokenCtor(type, tag, nesting);

	for (const match of matches) {
		if (match.start > cursor) {
			const before = newToken('text', '', 0);
			before.content = text.slice(cursor, match.start);
			out.push(before);
		}

		if (match.kind === 'deep-link') {
			const open = newToken('link_open', 'a', 1);
			open.attrSet('href', match.resolvedPath);
			const label = newToken('text', '', 0);
			label.content = match.display;
			const close = newToken('link_close', 'a', -1);
			out.push(open, label, close);
			cursor = match.end;
			continue;
		}

		if (match.kind === 'image') {
			const img = newToken('image', 'img', 0);
			img.attrSet('src', `maestro-file://${match.resolvedPath}`);
			img.attrSet('data-maestro-image', match.resolvedPath);
			if (match.imageWidth) {
				img.attrSet('width', String(match.imageWidth));
			}
			// markdown-it's image renderer derives alt from token.content (set
			// from rendered children). Provide both so alt is populated whether
			// the renderer uses the attribute or the content path.
			img.attrSet('alt', match.display);
			img.content = match.display;
			const altText = newToken('text', '', 0);
			altText.content = match.display;
			img.children = [altText];
			out.push(img);
		} else {
			const open = newToken('link_open', 'a', 1);
			open.attrSet('href', `maestro-file://${match.resolvedPath}`);
			open.attrSet('data-maestro-file', match.resolvedPath);
			const label = newToken('text', '', 0);
			label.content = match.display;
			const close = newToken('link_close', 'a', -1);
			out.push(open, label, close);
		}

		cursor = match.end;
	}

	if (cursor < text.length) {
		const tail = newToken('text', '', 0);
		tail.content = text.slice(cursor);
		out.push(tail);
	}

	return out;
}

function collectInlineMatches(text: string, indices: FileTreeIndices, cwd: string): InlineMatch[] {
	const matches: InlineMatch[] = [];

	// Bare `maestro://` deep link URLs - auto-linkify so they are clickable.
	for (const deepLinkMatch of text.matchAll(MAESTRO_DEEP_LINK_PATTERN)) {
		const url = deepLinkMatch[0];
		const start = deepLinkMatch.index ?? 0;
		matches.push({
			start,
			end: start + url.length,
			kind: 'deep-link',
			resolvedPath: url,
			display: url,
		});
	}

	// Image embeds; their `![[…]]` envelope contains a `[[…]]` substring,
	// so we record image ranges before scanning wiki links and skip overlapping
	// wiki matches in the second pass.
	IMAGE_EMBED_PATTERN.lastIndex = 0;
	let imgMatch: RegExpExecArray | null;
	while ((imgMatch = IMAGE_EMBED_PATTERN.exec(text)) !== null) {
		const imagePath = imgMatch[1];
		const widthStr = imgMatch[2];
		const resolved = findClosestMatch(imagePath, indices, cwd) ?? `_attachments/${imagePath}`;
		matches.push({
			start: imgMatch.index,
			end: imgMatch.index + imgMatch[0].length,
			kind: 'image',
			resolvedPath: resolved,
			display: imagePath,
			imageWidth: widthStr ? parseInt(widthStr, 10) : undefined,
		});
	}

	WIKI_LINK_PATTERN.lastIndex = 0;
	let wikiMatch: RegExpExecArray | null;
	while ((wikiMatch = WIKI_LINK_PATTERN.exec(text)) !== null) {
		const inside = matches.some((m) => wikiMatch!.index >= m.start && wikiMatch!.index < m.end);
		if (inside) continue;

		const reference = wikiMatch[1];
		const displayText = wikiMatch[2];
		const resolved = findClosestMatch(reference, indices, cwd);
		if (!resolved) continue;

		matches.push({
			start: wikiMatch.index,
			end: wikiMatch.index + wikiMatch[0].length,
			kind: 'wiki',
			resolvedPath: resolved,
			display: displayText || reference,
		});
	}

	// Plain path references (e.g. `Folder/File.md` in running text) - but only
	// when they validate exactly against the file tree. Use the shared
	// PATH_PATTERN from patterns.ts so this stays in lockstep with the Rich-tier
	// remark plugin (the shared pattern also catches single-file references
	// like `helpers.ts` with a recognized extension, which a local /\b…\b/
	// would miss). PATH_PATTERN has the `g` flag, so reset lastIndex before
	// each pass to keep the exec loop self-contained.
	PATH_PATTERN.lastIndex = 0;
	let pathMatch: RegExpExecArray | null;
	while ((pathMatch = PATH_PATTERN.exec(text)) !== null) {
		const inside = matches.some((m) => pathMatch!.index >= m.start && pathMatch!.index < m.end);
		if (inside) continue;

		const resolved = validatePathReference(pathMatch[0], indices);
		if (!resolved) continue;

		matches.push({
			start: pathMatch.index,
			end: pathMatch.index + pathMatch[0].length,
			kind: 'wiki',
			resolvedPath: resolved,
			display: pathMatch[0],
		});
	}

	matches.sort((a, b) => a.start - b.start);
	return matches;
}
