/**
 * One markdown file to one Dataview page (DV-3). This is Maestro's replacement for the step Obsidian's
 * `FullIndex.reload` + `finish` runs per file: M1 (`extractMetadata`) stands in for Obsidian's
 * `CachedMetadata`, the vendored upstream `parsePage` does the rest unchanged (inline fields, tags,
 * aliases, lists, tasks, `file.day`), and `PageMetadata.canonicalize` resolves every link through M3, as
 * upstream's `finish` does through `getFirstLinkpathDest`.
 *
 * Pure: no file system access. The main-process index (phase 04) reads the file and its stat and calls this.
 */

import { parsePage as parseVendoredPage } from './vendor/data-import/markdown-file';
import { PageMetadata } from './vendor/data-model/markdown';
import type { Link } from './vendor/data-model/value';
import { extractMetadata } from './metadata';
import type { LinkResolver } from './resolve';

export interface PageInput {
	/** Vault-relative POSIX path, e.g. `People/Pedram Amini.md`. */
	path: string;
	/** The file's text. `\r\n` and lone `\r` endings are normalized to `\n`. */
	content: string;
	/** Creation time in ms (`birthtimeMs`; see the guide's "Semantics traps"). Backs `file.ctime` and `file.cday`. */
	ctime: number;
	/** Modification time in ms. Backs `file.mtime` and `file.mday`. */
	mtime: number;
	/** Size in bytes. Backs `file.size`. */
	size: number;
}

/** A problem found while parsing a page. The page is still returned; the warning names what was dropped. */
export interface PageParseWarning {
	path: string;
	/** 0-based line the problem starts on. */
	line: number;
	message: string;
}

export interface ParsePageOptions {
	/** Called once per warning (for example invalid YAML frontmatter, which yields an empty frontmatter). */
	onWarning?: (warning: PageParseWarning) => void;
}

/**
 * Parse one markdown file into Dataview's `PageMetadata`, with every link resolved against the vault.
 * Never throws on malformed input: problems are reported through `options.onWarning`. A link that does not
 * resolve keeps the path it was written with.
 */
export function parsePage(
	input: PageInput,
	resolver: LinkResolver,
	options: ParsePageOptions = {}
): PageMetadata {
	return finishPage(parseRawPage(input, options), resolver);
}

/**
 * The first half of {@link parsePage}: M1 plus the vendored parser, with every link still as written. This
 * is what the disk cache stores (as upstream's persister does), because how a link resolves depends on the
 * other files in the vault, which can change while the file itself does not.
 */
export function parseRawPage(input: PageInput, options: ParsePageOptions = {}): PageMetadata {
	const content = input.content.replace(/\r\n?/g, '\n');
	const { metadata, warnings } = extractMetadata(content);
	for (const warning of warnings) options.onWarning?.({ path: input.path, ...warning });

	return parseVendoredPage(
		input.path,
		content,
		{ ctime: input.ctime, mtime: input.mtime, size: input.size },
		metadata
	);
}

/**
 * The second half of {@link parsePage}: resolve every link of a raw page through M3, as upstream's `finish`
 * does through `getFirstLinkpathDest`. `PageMetadata.canonicalize` MUTATES `raw`, so pass a fresh copy (a
 * decoded cache entry, or a page nothing else holds).
 */
export function finishPage(raw: Partial<PageMetadata>, resolver: LinkResolver): PageMetadata {
	const path = raw.path ?? '';
	return PageMetadata.canonicalize(raw, (link: Link) => {
		const target = resolver.resolve(link.path, path);
		return target ? link.withPath(target) : link;
	});
}
