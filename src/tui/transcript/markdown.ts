/**
 * Markdown to a small block model the terminal can draw.
 *
 * `marked` does the parsing (its lexer, not its HTML renderer). This module
 * folds the token tree into `Block`s of styled spans: headings, paragraphs,
 * lists, tables, fenced code, blockquotes, and rules. Links are shown as text
 * (`label (url)`), images as `[image: alt]`, and raw HTML as the text it
 * contains, since a terminal has nothing to render it with.
 *
 * Pure: no Ink, no I/O. `MarkdownView` draws the result.
 */

import { Lexer, type Token, type Tokens } from 'marked';
import { highlightCode, type StyledSpan } from './highlight';

export type { StyledSpan } from './highlight';

export type Block =
	| { kind: 'heading'; depth: number; spans: StyledSpan[] }
	| { kind: 'paragraph'; spans: StyledSpan[] }
	| { kind: 'code'; language: string | undefined; lines: StyledSpan[][] }
	| { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
	| { kind: 'quote'; blocks: Block[] }
	| { kind: 'table'; header: StyledSpan[][]; rows: StyledSpan[][][]; align: TableAlign[] }
	| { kind: 'rule' };

export type TableAlign = 'left' | 'right' | 'center';

export interface ListItem {
	/** `undefined` for an ordinary item; a task item carries its box state. */
	checked: boolean | undefined;
	blocks: Block[];
}

type InlineStyle = Omit<StyledSpan, 'text'>;

/** Plain text of a span run, for width math and tests. */
export function spansText(spans: readonly StyledSpan[]): string {
	return spans.map((span) => span.text).join('');
}

function inlineSpans(tokens: Token[] | undefined, style: InlineStyle = {}): StyledSpan[] {
	if (!tokens) return [];
	const spans: StyledSpan[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'strong':
				spans.push(...inlineSpans((token as Tokens.Strong).tokens, { ...style, bold: true }));
				break;
			case 'em':
				spans.push(...inlineSpans((token as Tokens.Em).tokens, { ...style, italic: true }));
				break;
			case 'del':
				spans.push(...inlineSpans((token as Tokens.Del).tokens, { ...style, strikethrough: true }));
				break;
			case 'codespan':
				spans.push({ ...style, text: (token as Tokens.Codespan).text, color: 'yellow' });
				break;
			case 'br':
				spans.push({ ...style, text: '\n' });
				break;
			case 'link': {
				const link = token as Tokens.Link;
				const label = inlineSpans(link.tokens, { ...style, color: 'blue', underline: true });
				spans.push(...label);
				// The URL is the point of a link in a terminal; show it unless the label already is it.
				if (link.href && spansText(label) !== link.href) {
					spans.push({ ...style, text: ` (${link.href})`, dimColor: true });
				}
				break;
			}
			case 'image': {
				const image = token as Tokens.Image;
				spans.push({ ...style, text: `[image: ${image.text || image.href}]`, dimColor: true });
				break;
			}
			case 'escape':
			case 'text': {
				const text = token as Tokens.Text | Tokens.Escape;
				const nested = 'tokens' in text ? text.tokens : undefined;
				if (nested && nested.length > 0) spans.push(...inlineSpans(nested, style));
				else spans.push({ ...style, text: text.text });
				break;
			}
			default: {
				// Raw HTML and anything a newer marked adds: show the text, never drop it.
				const raw = token as { text?: string; raw?: string };
				const text = raw.text ?? raw.raw ?? '';
				if (text) spans.push({ ...style, text });
			}
		}
	}
	return spans;
}

function listItemBlocks(item: Tokens.ListItem): Block[] {
	return blocksFromTokens(item.tokens);
}

function blocksFromTokens(tokens: Token[]): Block[] {
	const blocks: Block[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'heading': {
				const heading = token as Tokens.Heading;
				blocks.push({
					kind: 'heading',
					depth: heading.depth,
					spans: inlineSpans(heading.tokens),
				});
				break;
			}
			case 'paragraph':
			case 'text': {
				// A `text` token at block level is a tight list item's body.
				const text = token as Tokens.Paragraph | Tokens.Text;
				const spans = text.tokens ? inlineSpans(text.tokens) : [{ text: text.text }];
				if (spans.length > 0) blocks.push({ kind: 'paragraph', spans });
				break;
			}
			case 'code': {
				const code = token as Tokens.Code;
				blocks.push({
					kind: 'code',
					language: code.lang?.trim().split(/\s+/)[0] || undefined,
					lines: highlightCode(code.text, code.lang),
				});
				break;
			}
			case 'list': {
				const list = token as Tokens.List;
				blocks.push({
					kind: 'list',
					ordered: list.ordered,
					start: typeof list.start === 'number' ? list.start : 1,
					items: list.items.map((item) => ({
						checked: item.task ? Boolean(item.checked) : undefined,
						// A task item leads with a `checkbox` token the bullet already stands for.
						blocks: listItemBlocks({
							...item,
							tokens: item.tokens.filter((child) => child.type !== 'checkbox'),
						}),
					})),
				});
				break;
			}
			case 'blockquote':
				blocks.push({
					kind: 'quote',
					blocks: blocksFromTokens((token as Tokens.Blockquote).tokens),
				});
				break;
			case 'table': {
				const table = token as Tokens.Table;
				blocks.push({
					kind: 'table',
					header: table.header.map((cell) => inlineSpans(cell.tokens, { bold: true })),
					rows: table.rows.map((row) => row.map((cell) => inlineSpans(cell.tokens))),
					align: table.align.map((align) => align ?? 'left'),
				});
				break;
			}
			case 'hr':
				blocks.push({ kind: 'rule' });
				break;
			case 'html': {
				const html = (token as Tokens.HTML).text.trim();
				if (html) blocks.push({ kind: 'paragraph', spans: [{ text: html, dimColor: true }] });
				break;
			}
			// `space` is a blank line between blocks; the view spaces blocks itself.
			default:
				break;
		}
	}
	return blocks;
}

export function parseMarkdown(markdown: string): Block[] {
	return blocksFromTokens(Lexer.lex(markdown));
}
