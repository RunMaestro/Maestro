/**
 * M1: markdown text to an Obsidian-shaped `CachedMetadata` (DV-3). Obsidian's metadata cache is closed
 * source; the vendored `parsePage` reads only the fields documented in docs/agent-guides/DATAVIEW.md
 * ("M1 rules"), and this module produces exactly those.
 *
 * Block structure comes from markdown-it tokens (DEV-4): fenced and indented code, inline code spans, and
 * HTML are separate tokens, so links and tags inside them are skipped without a hand-rolled fence scan.
 * Lines are 0-based, as in Obsidian. Input must already use `\n` line endings.
 */

import MarkdownIt from 'markdown-it';
import * as yaml from 'js-yaml';
import { WIKI_LINK_PATTERN } from '../fileLinkPatterns';
import type {
	CachedMetadata,
	EmbedCache,
	FrontMatterCache,
	FrontmatterLinkCache,
	HeadingCache,
	LinkCache,
	ListItemCache,
	Loc,
	Pos,
	SectionCache,
	TagCache,
} from './vendor/obsidian-shim';
import { LIST_ITEM_REGEX } from './vendor/data-import/markdown-file';

export type MarkdownToken = ReturnType<MarkdownIt['parse']>[number];
type Token = MarkdownToken;

/** A problem found while reading a page. The page still indexes; the warning says what was dropped. */
export interface MetadataWarning {
	/** 0-based line the problem starts on. */
	line: number;
	message: string;
}

export interface ExtractedMetadata {
	metadata: CachedMetadata;
	warnings: MetadataWarning[];
}

// `html: true` so raw HTML becomes html tokens (skipped) instead of text that could hold tags and links.
// `linkify: false` so a bare URL never becomes a link: Obsidian does not index bare URLs.
const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

/** `[[...]]` and `![[...]]`, located with the same pattern the preview renders as a wiki link. */
const WIKI_OR_EMBED = new RegExp(`(!?)${WIKI_LINK_PATTERN.source}`, 'g');

/**
 * An inline tag: `#` at the start of a line or after whitespace, then the characters Dataview's own
 * `EXPRESSION.tag` parser accepts (vendored `expression/parse.ts`). Obsidian also rejects all-digit tags.
 */
const INLINE_TAG = /(?<=^|\s)#([^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+)/gu;

/** Obsidian comments (`%%hidden%%`) are not indexed. */
const COMMENT = /%%[\s\S]*?%%/g;

/** A trailing block id (`text ^my-id`). */
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;

/** A URL scheme (`https:`, `mailto:`, `obsidian:`) or a protocol-relative `//host`: not a vault link. */
const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Block token types that map to an Obsidian section type. */
const SECTION_TYPES: Record<string, string> = {
	fence: 'code',
	code_block: 'code',
	heading_open: 'heading',
	paragraph_open: 'paragraph',
	bullet_list_open: 'list',
	ordered_list_open: 'list',
	blockquote_open: 'blockquote',
	table_open: 'table',
	hr: 'thematicBreak',
	html_block: 'html',
};

export interface FrontmatterBlock {
	/** 0-based line of the closing `---`. */
	endLine: number;
	text: string;
}

/** The YAML block between a first-line `---` and the next `---` line, as Obsidian reads it. */
export function findFrontmatter(lines: string[]): FrontmatterBlock | null {
	if (lines.length < 2 || lines[0].trimEnd() !== '---') return null;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trimEnd() === '---') return { endLine: i, text: lines.slice(1, i).join('\n') };
	}
	return null;
}

/**
 * markdown-it's tokens for a file's lines. The frontmatter, when there is one, is blanked first so its
 * YAML never parses as markdown and the tokens' line maps stay file-relative (0-based).
 */
export function tokenizeMarkdownLines(
	lines: string[],
	frontmatter: FrontmatterBlock | null = findFrontmatter(lines)
): MarkdownToken[] {
	const body = frontmatter
		? lines.map((line, index) => (index <= frontmatter.endLine ? '' : line))
		: lines;
	return md.parse(body.join('\n'), {});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
	);
}

/** One entry per `[[...]]` inside a frontmatter string, at any depth (Dataview adds them to `file.outlinks`). */
function collectFrontmatterLinks(value: unknown, key: string, out: FrontmatterLinkCache[]): void {
	if (typeof value === 'string') {
		WIKI_OR_EMBED.lastIndex = 0;
		for (const match of value.matchAll(WIKI_OR_EMBED)) {
			const reference = toReference(match);
			out.push({ key, ...reference });
		}
	} else if (Array.isArray(value)) {
		value.forEach((child, index) => collectFrontmatterLinks(child, `${key}.${index}`, out));
	} else if (isPlainObject(value)) {
		for (const [child, childValue] of Object.entries(value)) {
			collectFrontmatterLinks(childValue, `${key}.${child}`, out);
		}
	}
}

/** Split a `[[target#sub|alias]]` match into Obsidian's `link`, `original`, and `displayText`. */
function toReference(match: RegExpMatchArray): {
	link: string;
	original: string;
	displayText: string;
} {
	const target = match[2];
	const alias = match[3];
	return { link: target, original: match[0], displayText: alias ?? target };
}

function lineStartOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}
	return offsets;
}

/**
 * Extract the `CachedMetadata` for one markdown file. Never throws: invalid YAML frontmatter yields no
 * `frontmatter` plus a warning, and the body still indexes.
 */
export function extractMetadata(content: string): ExtractedMetadata {
	const lines = content.split('\n');
	const offsets = lineStartOffsets(lines);
	const warnings: MetadataWarning[] = [];
	const metadata: CachedMetadata = {};

	const loc = (line: number, col: number): Loc => ({ line, col, offset: offsets[line] + col });
	const span = (startLine: number, endLine: number, startCol = 0): Pos => ({
		start: loc(startLine, startCol),
		end: loc(endLine, lines[endLine].length),
	});
	/** The last non-blank line in `[start, end]`, never before `start`. */
	const trimBlankTail = (start: number, end: number): number => {
		let last = Math.min(end, lines.length - 1);
		while (last > start && lines[last].trim() === '') last--;
		return last;
	};

	const sections: SectionCache[] = [];
	const frontmatterBlock = findFrontmatter(lines);
	if (frontmatterBlock) {
		const { endLine, text } = frontmatterBlock;
		metadata.frontmatterPosition = span(0, endLine);
		sections.push({ type: 'yaml', position: span(0, endLine) });
		try {
			const parsed = yaml.load(text, { schema: yaml.CORE_SCHEMA });
			if (isPlainObject(parsed)) {
				metadata.frontmatter = parsed as FrontMatterCache;
				const links: FrontmatterLinkCache[] = [];
				for (const [key, value] of Object.entries(parsed))
					collectFrontmatterLinks(value, key, links);
				if (links.length > 0) metadata.frontmatterLinks = links;
			} else if (parsed !== null && parsed !== undefined) {
				warnings.push({ line: 0, message: 'Frontmatter is not a YAML mapping; it was ignored.' });
			}
		} catch (error) {
			const yamlError = error as { reason?: string; message?: string; mark?: { line?: number } };
			// js-yaml lines are 0-based within the YAML text, which starts on file line 1. An end-of-stream
			// error points one past the last YAML line, so clamp it to the block.
			const line =
				typeof yamlError.mark?.line === 'number'
					? Math.min(yamlError.mark.line + 1, Math.max(1, endLine - 1))
					: 0;
			warnings.push({
				line,
				message: `Invalid YAML frontmatter: ${yamlError.reason ?? yamlError.message ?? String(error)}`,
			});
		}
	}

	const tokens = tokenizeMarkdownLines(lines, frontmatterBlock);

	const links: LinkCache[] = [];
	const embeds: EmbedCache[] = [];
	const tags: TagCache[] = [];
	const headings: HeadingCache[] = [];
	const listItems: ListItemCache[] = [];

	/** Scan the visible text of one inline token for wiki links, embeds, and tags. */
	const scanInline = (inline: Token, firstLine: number) => {
		// Rebuild the token's text one line at a time with markup dropped and code spans and inline HTML
		// blanked, so nothing inside code is indexed and soft breaks give each hit its line.
		const lineTexts: string[] = [''];
		for (const child of inline.children ?? []) {
			if (child.type === 'softbreak' || child.type === 'hardbreak') lineTexts.push('');
			else if (child.type === 'text') lineTexts[lineTexts.length - 1] += child.content;
			else if (child.type === 'code_inline' || child.type === 'html_inline')
				lineTexts[lineTexts.length - 1] += ' ';
		}
		const joined = lineTexts
			.join('\n')
			.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, ' '));
		joined.split('\n').forEach((text, index) => {
			const line = Math.min(firstLine + index, lines.length - 1);
			WIKI_OR_EMBED.lastIndex = 0;
			for (const match of text.matchAll(WIKI_OR_EMBED)) {
				const entry = { ...toReference(match), position: span(line, line) };
				(match[1] === '!' ? embeds : links).push(entry);
			}
			INLINE_TAG.lastIndex = 0;
			for (const match of text.matchAll(INLINE_TAG)) {
				if (/^\d+$/.test(match[1])) continue;
				tags.push({ tag: `#${match[1]}`, position: span(line, line) });
			}
		});

		// Markdown links and images name their target in `href` / `src`; markdown-it encodes it, so decode.
		let line = firstLine;
		const children = inline.children ?? [];
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (child.type === 'softbreak' || child.type === 'hardbreak') line++;
			const isLink = child.type === 'link_open';
			if (!isLink && child.type !== 'image') continue;
			const target = child.attrGet(isLink ? 'href' : 'src');
			if (!target || EXTERNAL_HREF.test(target)) continue;
			let text = '';
			if (isLink) {
				for (let j = i + 1; j < children.length && children[j].type !== 'link_close'; j++)
					text += children[j].content;
			} else text = child.content;
			const decoded = md.normalizeLinkText(target);
			const position = span(Math.min(line, lines.length - 1), Math.min(line, lines.length - 1));
			const entry = { link: decoded, original: decoded, displayText: text || decoded, position };
			(isLink ? links : embeds).push(entry);
		}
	};

	interface OpenList {
		firstLine: number;
		parentItem: OpenItem | null;
	}
	interface OpenItem {
		cache: ListItemCache;
		/** Last line of the item's own text (before its first nested list); `null` until known. */
		ownEnd: number | null;
		mapEnd: number;
	}
	const listStack: OpenList[] = [];
	const itemStack: OpenItem[] = [];
	/** The innermost block whose line map applies to the inline tokens inside it (table cells have none). */
	let blockLine = 0;

	const closeItem = (item: OpenItem) => {
		const start = item.cache.position.start.line;
		const end = trimBlankTail(start, item.ownEnd ?? item.mapEnd);
		item.cache.position = span(start, end, item.cache.position.start.col);
		const id = BLOCK_ID.exec(lines[end]);
		if (id) item.cache.id = id[1];
	};

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.map) blockLine = token.map[0];

		if (token.level === 0 && token.map && SECTION_TYPES[token.type]) {
			const start = token.map[0];
			let type = SECTION_TYPES[token.type];
			if (type === 'blockquote' && /^\s*>\s*\[!/.test(lines[start])) type = 'callout';
			sections.push({ type, position: span(start, trimBlankTail(start, token.map[1] - 1)) });
		}

		switch (token.type) {
			case 'heading_open': {
				const inline = tokens[index + 1];
				if (token.map && inline?.type === 'inline') {
					headings.push({
						heading: inline.content,
						level: Number(token.tag.slice(1)),
						position: span(token.map[0], token.map[0]),
					});
				}
				break;
			}
			case 'inline':
				scanInline(token, token.map ? token.map[0] : blockLine);
				break;
			case 'bullet_list_open':
			case 'ordered_list_open': {
				const parentItem = itemStack.length > 0 ? itemStack[itemStack.length - 1] : null;
				if (parentItem && parentItem.ownEnd === null && token.map)
					parentItem.ownEnd = token.map[0] - 1;
				listStack.push({ firstLine: token.map ? token.map[0] : blockLine, parentItem });
				break;
			}
			case 'bullet_list_close':
			case 'ordered_list_close':
				listStack.pop();
				break;
			case 'list_item_open': {
				if (!token.map) break;
				const start = token.map[0];
				const list = listStack[listStack.length - 1];
				// Obsidian: a root item's parent is the negative of the list's first line. A list on line 0
				// would give -0, which reads as "line 0 is my parent", so use -1 there.
				const parent = list?.parentItem
					? list.parentItem.cache.position.start.line
					: list && list.firstLine > 0
						? -list.firstLine
						: -1;
				const marker = LIST_ITEM_REGEX.exec(lines[start]);
				const checkbox = marker?.[2];
				const cache: ListItemCache = {
					parent,
					position: span(start, start, lines[start].search(/\S|$/)),
					...(checkbox && checkbox.length === 3 ? { task: checkbox[1] } : {}),
				};
				listItems.push(cache);
				itemStack.push({ cache, ownEnd: null, mapEnd: token.map[1] - 1 });
				break;
			}
			case 'list_item_close': {
				const item = itemStack.pop();
				if (item) closeItem(item);
				break;
			}
		}
	}

	sections.sort((a, b) => a.position.start.line - b.position.start.line);
	listItems.sort((a, b) => a.position.start.line - b.position.start.line);

	if (links.length > 0) metadata.links = links;
	if (embeds.length > 0) metadata.embeds = embeds;
	if (tags.length > 0) metadata.tags = tags;
	if (headings.length > 0) metadata.headings = headings;
	if (sections.length > 0) metadata.sections = sections;
	if (listItems.length > 0) metadata.listItems = listItems;
	return { metadata, warnings };
}
