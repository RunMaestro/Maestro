/**
 * How Dataview values read in a rendered result. Shared by the preview's React renderer (`DataviewValue`)
 * and the DataviewJS guest's DOM renderer, so a value looks the same in a `dataview` block and in a
 * `dataviewjs` block.
 */

import { getFileTitle } from './vendor/util/normalize';
import type { Link } from './vendor/data-model/value';

/**
 * The text Dataview shows for a link: its display, or the file title plus the section. The same label
 * upstream's `Link.markdown()` writes after the `|`.
 */
export function dataviewLinkLabel(link: Link): string {
	if (link.display) return link.display;
	const title = getFileTitle(link.path);
	return link.type === 'header' || link.type === 'block' ? `${title} > ${link.subpath}` : title;
}

/** Strings with none of these characters are plain text and skip the markdown parse. */
const MARKDOWN_SYNTAX = /[\\`*_~[\]<>|#!&]|https?:|www\.|^\s*(?:[-+]|\d+[.)])\s/;

/** Whether a string may hold markdown. One that cannot renders as plain text, with no parse. */
export function mayContainMarkdown(text: string): boolean {
	return MARKDOWN_SYNTAX.test(text);
}
