import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	findByOmpSessionId,
	readMap,
	resolveRecord,
	type SessionMapRecord,
	touchRecord,
	upsertRecord,
} from '../session-map';

async function tmpMap(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-map-'));
	return path.join(dir, 'session-map.json');
}

function rec(
	over: Partial<SessionMapRecord> & { maestroSessionId: string; ompSessionId: string }
): SessionMapRecord {
	return { engine: 'omp', cwd: '/repo', runId: 'r', startedAt: 1, lastActiveAt: 1, ...over };
}

describe('session map', () => {
	test('upsert creates then updates in place', async () => {
		const map = await tmpMap();
		await upsertRecord(map, rec({ maestroSessionId: 'a', ompSessionId: '/s/a.jsonl', title: 'A' }));
		await upsertRecord(
			map,
			rec({ maestroSessionId: 'a', ompSessionId: '/s/a.jsonl', title: 'A2', lastActiveAt: 5 })
		);
		const all = await readMap(map);
		expect(all.length).toBe(1);
		expect(all[0].title).toBe('A2');
		expect(all[0].lastActiveAt).toBe(5);
	});

	test('readMap drops malformed records', async () => {
		const map = await tmpMap();
		await fs.mkdir(path.dirname(map), { recursive: true });
		await fs.writeFile(
			map,
			JSON.stringify({
				version: '1',
				records: [{ junk: true }, rec({ maestroSessionId: 'a', ompSessionId: 'o' })],
			})
		);
		expect((await readMap(map)).length).toBe(1);
	});

	test('touchRecord updates lastActiveAt only when present', async () => {
		const map = await tmpMap();
		await upsertRecord(map, rec({ maestroSessionId: 'a', ompSessionId: 'o' }));
		await touchRecord(map, 'a', 999);
		await touchRecord(map, 'missing', 1234);
		const all = await readMap(map);
		expect(all.length).toBe(1);
		expect(all[0].lastActiveAt).toBe(999);
	});

	test('findByOmpSessionId returns the mapped record', async () => {
		const map = await tmpMap();
		await upsertRecord(map, rec({ maestroSessionId: 'a', ompSessionId: '/s/a.jsonl' }));
		expect((await findByOmpSessionId(map, '/s/a.jsonl'))?.maestroSessionId).toBe('a');
		expect(await findByOmpSessionId(map, '/s/none.jsonl')).toBeUndefined();
	});

	test('resolveRecord by recency, exact id, prefix, title, and miss', async () => {
		const map = await tmpMap();
		await upsertRecord(
			map,
			rec({
				maestroSessionId: 'alpha',
				ompSessionId: '/s/a.jsonl',
				title: 'Alpha build',
				lastActiveAt: 1,
			})
		);
		await upsertRecord(
			map,
			rec({
				maestroSessionId: 'beta',
				ompSessionId: '/s/b.jsonl',
				title: 'Beta build',
				lastActiveAt: 9,
			})
		);
		expect((await resolveRecord(map))?.maestroSessionId).toBe('beta'); // recency
		expect((await resolveRecord(map, 'alpha'))?.maestroSessionId).toBe('alpha'); // exact id
		expect((await resolveRecord(map, 'al'))?.maestroSessionId).toBe('alpha'); // prefix
		expect((await resolveRecord(map, 'Beta b'))?.maestroSessionId).toBe('beta'); // title substring
		expect(await resolveRecord(map, 'zzz')).toBeUndefined();
		expect(await resolveRecord(await tmpMap())).toBeUndefined(); // empty map
	});
});
