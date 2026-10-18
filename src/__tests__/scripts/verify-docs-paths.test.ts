/**
 * scripts/verify-docs-paths.mjs (`npm run docs:verify`) keeps CLAUDE.md's
 * "Commonly-reimplemented functions" list an INDEX. CLAUDE.md is loaded into
 * every agent session, and that list once grew to 212KB because nothing
 * stopped a full rationale from being written into an index line. These tests
 * pin each finding the script reports, and that the real repo passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	CANON_DOC,
	INDEX_DOC,
	INDEX_HEADING,
	MAX_INDEX_LINE,
	verifyDocs,
} from '../../../scripts/verify-docs-paths.mjs';

const REPO_ROOT = path.join(__dirname, '../../..');

function plant(root: string, relative: string, content = 'x'): void {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/** A CLAUDE.md whose index holds `lines`, followed by an unrelated section. */
function indexDoc(lines: string[]): string {
	return [
		'# CLAUDE.md',
		'',
		`${INDEX_HEADING} (do NOT add new copies)`,
		'',
		...lines,
		'',
		'## Next Section',
		'',
		'- **Not an index entry:** a bullet in another section',
		'',
	].join('\n');
}

describe('verify-docs-paths', () => {
	let sandbox: string;

	beforeEach(() => {
		sandbox = mkdtempSync(path.join(tmpdir(), 'verify-docs-paths-'));
		plant(sandbox, 'src/shared/formatters.ts');
	});

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	function write(indexLines: string[], canonLines: string[]): void {
		plant(sandbox, INDEX_DOC, indexDoc(indexLines));
		plant(sandbox, CANON_DOC, ['# Canonical Utilities', '', ...canonLines, ''].join('\n'));
	}

	const INDEX_LINE = '- **Format cost:** `formatCost()` in `src/shared/formatters.ts`';
	const CANON_LINE =
		'- **Format cost:** `formatCost()` in `src/shared/formatters.ts`. The why goes here.';

	it('passes when every path resolves and both files list the same titles', () => {
		write([INDEX_LINE], [CANON_LINE]);

		expect(verifyDocs(sandbox)).toEqual({
			findings: [],
			checkedPaths: 2,
			indexEntries: 1,
			canonEntries: 1,
		});
	});

	it('reports a path that no longer exists, naming the doc that asserts it', () => {
		write(
			['- **Format cost:** `formatCost()` in `src/shared/gone.ts`'],
			['- **Format cost:** `formatCost()` in `src/shared/formatters.ts`']
		);

		expect(verifyDocs(sandbox).findings).toEqual([
			`MISSING: src/shared/gone.ts (asserted in ${INDEX_DOC})`,
		]);
	});

	it('reports an index line that has grown past one line of symbols and paths', () => {
		const bloated = `${INDEX_LINE}. ${'Rationale that belongs next door. '.repeat(12)}`;
		expect(bloated.length).toBeGreaterThan(MAX_INDEX_LINE);
		write([bloated], [CANON_LINE]);

		const { findings } = verifyDocs(sandbox);

		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain('"Format cost"');
		expect(findings[0]).toContain(`max ${MAX_INDEX_LINE}`);
	});

	it('leaves a long entry in the full-rationale file alone', () => {
		write([INDEX_LINE], [`${CANON_LINE} ${'A long reasoned paragraph. '.repeat(40)}`]);

		expect(verifyDocs(sandbox).findings).toEqual([]);
	});

	it('reports an index line with no full entry, and a full entry with no index line', () => {
		write(
			[INDEX_LINE, '- **Only in the index:** `a()` in `src/shared/formatters.ts`'],
			[CANON_LINE, '- **Only in the canon:** `b()` in `src/shared/formatters.ts`']
		);

		expect(verifyDocs(sandbox).findings).toEqual([
			`INDEX: "Only in the index" has no full entry in ${CANON_DOC}`,
			`INDEX: "Only in the canon" has no index line in ${INDEX_DOC}`,
		]);
	});

	it('reports a title listed twice in either file', () => {
		write([INDEX_LINE, INDEX_LINE], [CANON_LINE, CANON_LINE]);

		expect(verifyDocs(sandbox).findings).toEqual([
			`INDEX: "Format cost" is listed twice in ${INDEX_DOC}`,
			`INDEX: "Format cost" has two entries in ${CANON_DOC}`,
		]);
	});

	it('does not read bullets outside the index section as index entries', () => {
		write([INDEX_LINE], [CANON_LINE]);

		// indexDoc() plants a `- **...:**` bullet under the next `## ` heading.
		expect(verifyDocs(sandbox).indexEntries).toBe(1);
	});

	it('reports a CLAUDE.md that has lost the index heading', () => {
		plant(sandbox, INDEX_DOC, '# CLAUDE.md\n');
		plant(sandbox, CANON_DOC, `${CANON_LINE}\n`);

		expect(verifyDocs(sandbox).findings).toEqual([
			`INDEX: "${INDEX_HEADING}" heading not found in ${INDEX_DOC}`,
		]);
	});

	it('passes on this repository', () => {
		const result = verifyDocs(REPO_ROOT);

		expect(result.findings).toEqual([]);
		expect(result.indexEntries).toBeGreaterThan(0);
		expect(result.indexEntries).toBe(result.canonEntries);
	});
});
