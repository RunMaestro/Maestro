/**
 * The result row cap (`DATAVIEW_MAX_RESULT_ROWS` in src/shared/dataview/execute.ts): a query past it keeps
 * its first rows (top-level tasks for `TASK`, inside their `GROUP BY` levels) and says how many there were,
 * so a large vault without `LIMIT` cannot flood IPC or the preview.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	DATAVIEW_MAX_RESULT_ROWS,
	countTaskGroupRows,
	dataviewTruncationNote,
	executeDql,
	type DataviewResult,
} from '../../../shared/dataview';
import { formatCount } from '../../../shared/formatters';
import { createLocalVaultFs } from '../../../main/dataview/vault-fs';
import { VaultIndex } from '../../../main/dataview/vault-index';

const PAGE_COUNT = DATAVIEW_MAX_RESULT_ROWS + 3;
const THIS_PATH = 'Bulk/Note 0000.md';

let tempDir: string;
let index: VaultIndex;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-result-cap-'));
	fs.mkdirSync(path.join(tempDir, 'Bulk'));
	for (let i = 0; i < PAGE_COUNT; i++) {
		const name = `Note ${String(i).padStart(4, '0')}.md`;
		fs.writeFileSync(path.join(tempDir, 'Bulk', name), `# ${name}\n\n- [ ] task ${i}\n`);
	}
	index = new VaultIndex(createLocalVaultFs(tempDir), { onWarning: () => {}, watch: false });
	await index.scan();
});

afterAll(async () => {
	await index.dispose();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const run = (source: string): Promise<DataviewResult> => executeDql(source, THIS_PATH, index);

describe('the result row cap', () => {
	it('keeps the first rows of a table and says how many there were', async () => {
		const result = await run('TABLE file.name FROM "Bulk" SORT file.name ASC');
		expect(result).toMatchObject({ kind: 'table', total: PAGE_COUNT });
		if (result.kind !== 'table') throw new Error('expected a table');
		expect(result.rows).toHaveLength(DATAVIEW_MAX_RESULT_ROWS);
		expect(result.rows[0][1]).toBe('Note 0000');
	});

	it('caps a list the same way', async () => {
		const result = await run('LIST FROM "Bulk"');
		expect(result).toMatchObject({ kind: 'list', total: PAGE_COUNT });
		if (result.kind !== 'list') throw new Error('expected a list');
		expect(result.items).toHaveLength(DATAVIEW_MAX_RESULT_ROWS);
	});

	it('counts top-level tasks, flat and inside GROUP BY levels', async () => {
		const flat = await run('TASK FROM "Bulk"');
		expect(flat).toMatchObject({ kind: 'task', total: PAGE_COUNT });
		if (flat.kind !== 'task') throw new Error('expected tasks');
		expect(countTaskGroupRows(flat.groups as unknown[])).toBe(DATAVIEW_MAX_RESULT_ROWS);

		const grouped = await run('TASK FROM "Bulk" GROUP BY file.name');
		expect(grouped).toMatchObject({ kind: 'task', total: PAGE_COUNT });
		if (grouped.kind !== 'task') throw new Error('expected tasks');
		// One group per page, so the groups past the cap are dropped whole.
		expect(grouped.groups).toHaveLength(DATAVIEW_MAX_RESULT_ROWS);
		expect(countTaskGroupRows(grouped.groups as unknown[])).toBe(DATAVIEW_MAX_RESULT_ROWS);
	});

	it('leaves a result under the cap alone', async () => {
		const result = await run('LIST FROM "Bulk" LIMIT 5');
		expect(result).toMatchObject({ kind: 'list' });
		expect(result).not.toHaveProperty('total');
	});
});

describe('dataviewTruncationNote', () => {
	it('names how many rows are shown of how many', () => {
		expect(dataviewTruncationNote({ total: 12345 }, 1000)).toBe(
			`Showing the first ${formatCount(1000)} of ${formatCount(12345)} results. Add a LIMIT to the query to choose which.`
		);
	});

	it('is null when nothing was left out', () => {
		expect(dataviewTruncationNote({}, 10)).toBeNull();
		expect(dataviewTruncationNote({ total: 10 }, 10)).toBeNull();
	});
});

describe('countTaskGroupRows', () => {
	it('counts tasks, not the groups they sit in', () => {
		const task = { task: true, text: 't' };
		expect(
			countTaskGroupRows([
				{ key: 'a', rows: [task, task] },
				{ key: 'b', rows: [{ key: 'c', rows: [task] }] },
			])
		).toBe(3);
		expect(countTaskGroupRows([task, task])).toBe(2);
	});
});
