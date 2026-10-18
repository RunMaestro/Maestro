#!/usr/bin/env node
// Verifies the two halves of the canonical-utilities docs against the repo and
// against each other. Run via `npm run docs:verify`. Exits non-zero on any
// finding.
//
//   PATH   every `src/...` path asserted in either file still resolves on
//          disk. These files are ground truth for every agent session; a stale
//          path teaches an agent to import from a file that no longer exists.
//   INDEX  CLAUDE.md's "Commonly-reimplemented functions" list stays an INDEX:
//          one line per entry, at most MAX_INDEX_LINE characters, and exactly
//          the same set of titles as CANONICAL-UTILITIES.md.
//
// INDEX exists because CLAUDE.md is loaded into EVERY session. Nothing stopped
// an agent from writing a feature's whole rationale into its index line, and
// the list grew from one line per entry to 212KB (about 53K tokens paid on
// every turn of every conversation) while the full entries next door went
// stale. Rationale belongs in CANONICAL-UTILITIES.md, which is read on demand.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX_DOC = 'CLAUDE.md';
export const CANON_DOC = 'docs/agent-guides/CANONICAL-UTILITIES.md';
export const HEADLESS_DOC = 'docs/agent-guides/CLI-HEADLESS.md';
export const INDEX_HEADING = '### Commonly-reimplemented functions';
/** Room for a title, a handful of symbols, and two paths. Not for a paragraph. */
export const MAX_INDEX_LINE = 320;

/** `- **Title:** ...` entries, as [title, line]. */
function entryLines(text) {
	return text
		.split('\n')
		.map((line) => [line.match(/^- \*\*(.+?):\*\*/)?.[1], line])
		.filter(([title]) => title);
}

function duplicateTitles(list) {
	const titles = list.map(([title]) => title);
	return [...new Set(titles.filter((title, i) => titles.indexOf(title) !== i))];
}

/**
 * Check the docs under `root`. Returns every finding as a printable line, plus
 * the counts the summary reports. Pure apart from reading the tree, so a test
 * can point it at a fixture.
 */
export function verifyDocs(root) {
	const texts = {
		[INDEX_DOC]: readFileSync(resolve(root, INDEX_DOC), 'utf8'),
		[CANON_DOC]: readFileSync(resolve(root, CANON_DOC), 'utf8'),
	};
	if (existsSync(resolve(root, HEADLESS_DOC))) {
		texts[HEADLESS_DOC] = readFileSync(resolve(root, HEADLESS_DOC), 'utf8');
	}
	const findings = [];

	// --- PATH
	let checkedPaths = 0;
	for (const [doc, text] of Object.entries(texts)) {
		const paths = new Set(
			[...text.matchAll(/`(src\/[A-Za-z0-9_/.-]+\.(?:ts|tsx|md))`/g)].map((m) => m[1])
		);
		for (const p of paths) {
			checkedPaths++;
			if (!existsSync(resolve(root, p))) findings.push(`MISSING: ${p} (asserted in ${doc})`);
		}
	}

	// --- INDEX
	const indexStart = texts[INDEX_DOC].indexOf(INDEX_HEADING);
	if (indexStart === -1) {
		findings.push(`INDEX: "${INDEX_HEADING}" heading not found in ${INDEX_DOC}`);
		return { findings, checkedPaths, indexEntries: 0, canonEntries: 0 };
	}
	// The index runs to the next top-level section.
	const rest = texts[INDEX_DOC].slice(indexStart);
	const sectionEnd = rest.search(/\n## /);
	const index = entryLines(sectionEnd === -1 ? rest : rest.slice(0, sectionEnd));
	const canon = entryLines(texts[CANON_DOC]);

	for (const [title, line] of index) {
		if (line.length > MAX_INDEX_LINE) {
			findings.push(
				`INDEX: "${title}" is ${line.length} chars (max ${MAX_INDEX_LINE}). ` +
					`Keep the symbols and path in ${INDEX_DOC}; move the rest to ${CANON_DOC}.`
			);
		}
	}
	for (const title of duplicateTitles(index)) {
		findings.push(`INDEX: "${title}" is listed twice in ${INDEX_DOC}`);
	}
	for (const title of duplicateTitles(canon)) {
		findings.push(`INDEX: "${title}" has two entries in ${CANON_DOC}`);
	}

	const indexTitles = new Set(index.map(([title]) => title));
	const canonTitles = new Set(canon.map(([title]) => title));
	for (const title of indexTitles) {
		if (!canonTitles.has(title)) {
			findings.push(`INDEX: "${title}" has no full entry in ${CANON_DOC}`);
		}
	}
	for (const title of canonTitles) {
		if (!indexTitles.has(title)) {
			findings.push(`INDEX: "${title}" has no index line in ${INDEX_DOC}`);
		}
	}

	return { findings, checkedPaths, indexEntries: index.length, canonEntries: canon.length };
}

// Run only when invoked directly, so a test can import `verifyDocs`. Both sides
// go through realpath: Node resolves the entry module through symlinks but
// leaves argv[1] as typed.
const scriptPath = realpathSync(fileURLToPath(import.meta.url));

function invokedDirectly() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(resolve(process.argv[1])) === scriptPath;
	} catch {
		// argv[1] is not a file on disk (a REPL, `node -e`), so this was an import.
		return false;
	}
}

if (invokedDirectly()) {
	const result = verifyDocs(resolve(dirname(scriptPath), '..'));
	for (const finding of result.findings) console.error(finding);
	console.log(
		`docs:verify checked ${result.checkedPaths} asserted paths and ` +
			`${result.indexEntries} index entries against ${result.canonEntries} full entries, ` +
			`${result.findings.length} finding(s)`
	);
	process.exit(result.findings.length === 0 ? 0 : 1);
}
