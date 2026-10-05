import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	archiveClosedTab,
	CLOSED_TABS_DIR,
	closedTabsFile,
	MAX_CLOSED_TAB_ARCHIVE,
	readClosedTabs,
	removeClosedTabArchive,
} from '../closed-tabs';
import { MAX_PERSISTED_SESSION_LOGS } from '../../../deferredSessionContent';
import type { ClosedTabRecord } from '../../store/records';

function closed(id: string, extra: Record<string, unknown> = {}): ClosedTabRecord {
	return {
		tab: { id, logs: [{ id: `${id}-log`, text: 'hello' }], ...extra },
		index: 0,
		closedAt: 1,
	};
}

describe('closed-tab archive', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-tabs-test-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('names the file after the agent and percent-encodes anything that is not a plain id character', () => {
		expect(closedTabsFile(dir, 'abc-123_X')).toBe(
			path.join(dir, CLOSED_TABS_DIR, 'abc-123_X.json')
		);
		const odd = closedTabsFile(dir, '../evil/id');
		expect(path.dirname(odd)).toBe(path.join(dir, CLOSED_TABS_DIR));
		expect(path.basename(odd)).toBe('%2E%2E%2Fevil%2Fid.json');
	});

	it('keeps a closed tab with its whole transcript, in store format', async () => {
		await archiveClosedTab(dir, 'a1', closed('t1', { unknownTabField: { x: 1 } }));
		const text = fs.readFileSync(closedTabsFile(dir, 'a1'), 'utf-8');
		expect(text.startsWith('{\n\t"closedTabs"')).toBe(true);
		expect(await readClosedTabs(closedTabsFile(dir, 'a1'))).toEqual([
			closed('t1', { unknownTabField: { x: 1 } }),
		]);
	});

	it('puts the newest first and replaces a tab closed twice', async () => {
		await archiveClosedTab(dir, 'a1', closed('t1'));
		await archiveClosedTab(dir, 'a1', closed('t2'));
		await archiveClosedTab(dir, 'a1', closed('t1', { name: 'again' }));
		const entries = await readClosedTabs(closedTabsFile(dir, 'a1'));
		expect(entries.map((entry) => entry.tab.id)).toEqual(['t1', 't2']);
		expect(entries[0].tab.name).toBe('again');
	});

	it('bounds the archive like the desktop and caps each tab to the newest log entries', async () => {
		for (let i = 0; i < MAX_CLOSED_TAB_ARCHIVE + 3; i++) {
			await archiveClosedTab(dir, 'a1', closed(`t${i}`));
		}
		const entries = await readClosedTabs(closedTabsFile(dir, 'a1'));
		expect(entries).toHaveLength(MAX_CLOSED_TAB_ARCHIVE);
		expect(entries[0].tab.id).toBe(`t${MAX_CLOSED_TAB_ARCHIVE + 2}`);

		const logs = Array.from({ length: MAX_PERSISTED_SESSION_LOGS + 20 }, (_, i) => ({
			id: `l${i}`,
		}));
		await archiveClosedTab(dir, 'a2', { tab: { id: 'big', logs }, index: 2, closedAt: 9 });
		const [big] = await readClosedTabs(closedTabsFile(dir, 'a2'));
		expect(big.tab.logs).toHaveLength(MAX_PERSISTED_SESSION_LOGS);
		expect((big.tab.logs as Array<{ id: string }>)[0].id).toBe('l20');
	});

	it('reads a missing archive as empty', async () => {
		expect(await readClosedTabs(closedTabsFile(dir, 'none'))).toEqual([]);
	});

	it('moves a corrupt archive aside instead of refusing the close, and keeps its bytes', async () => {
		const file = closedTabsFile(dir, 'a1');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{ not json');
		await archiveClosedTab(dir, 'a1', closed('t1'));
		expect((await readClosedTabs(file)).map((entry) => entry.tab.id)).toEqual(['t1']);
		const sidecars = fs
			.readdirSync(path.dirname(file))
			.filter((name) => name.includes('.corrupt-'));
		expect(sidecars).toHaveLength(1);
		expect(fs.readFileSync(path.join(path.dirname(file), sidecars[0]), 'utf-8')).toBe('{ not json');
	});

	it('removes the archive with the agent and tolerates a missing one', async () => {
		await archiveClosedTab(dir, 'a1', closed('t1'));
		await removeClosedTabArchive(dir, 'a1');
		expect(fs.existsSync(closedTabsFile(dir, 'a1'))).toBe(false);
		await expect(removeClosedTabArchive(dir, 'a1')).resolves.toBeUndefined();
	});
});
