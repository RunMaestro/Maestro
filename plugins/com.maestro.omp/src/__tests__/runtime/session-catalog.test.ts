import { describe, expect, it } from 'vitest';
import {
	MAX_OMP_SESSION_CATALOG_ENTRIES,
	OmpSessionCatalog,
	OMP_SESSION_CATALOG_STORAGE_KEY,
} from '../../runtime/session-catalog';

describe('OmpSessionCatalog', () => {
	it('persists opaque session metadata and reloads exact private paths', async () => {
		const values = new Map<string, unknown>();
		const storage = {
			get: async (key: string) => values.get(key),
			set: async (key: string, value: string) => void values.set(key, value),
		};
		let time = 120;
		const catalog = new OmpSessionCatalog(storage, () => ++time);
		await catalog.load();
		await catalog.sync({
			sessionId: 'session-a',
			sessionFile: 'C:/private/a.jsonl',
			sessionName: 'A',
		});
		await catalog.sync({
			sessionId: 'session-b',
			sessionFile: 'C:/private/b.jsonl',
			sessionName: 'B',
		});
		await catalog.sync({
			sessionId: 'session-c',
			sessionFile: 'C:/private/c.jsonl',
			sessionName: 'C',
		});

		const persisted = values.get(OMP_SESSION_CATALOG_STORAGE_KEY);
		expect(typeof persisted).toBe('string');
		expect(String(persisted)).toContain('C:/private/b.jsonl');

		const reloaded = new OmpSessionCatalog(storage, () => 456);
		await reloaded.load();
		expect(reloaded.entries()).toEqual([
			{ id: 'session-c', title: 'C', updatedAt: 123 },
			{ id: 'session-b', title: 'B', updatedAt: 122 },
			{ id: 'session-a', title: 'A', updatedAt: 121 },
		]);
		expect(reloaded.sessionPath('session-b')).toBe('C:/private/b.jsonl');
		expect(JSON.stringify(reloaded.entries())).not.toContain('C:/private');
	});

	it('fails closed for corrupted, oversized, duplicate, unknown, and pathless entries', async () => {
		const storage = {
			get: async () =>
				JSON.stringify({
					version: 1,
					entries: [
						{ id: 'same', sessionFile: 'C:/private/a', title: 'A', updatedAt: 1 },
						{ id: 'same', sessionFile: 'C:/private/b', title: 'B', updatedAt: 2 },
					],
				}),
			set: async () => undefined,
		};
		const catalog = new OmpSessionCatalog(storage);
		await catalog.load();
		expect(catalog.entries()).toEqual([]);
		expect(catalog.sessionPath('same')).toBeUndefined();

		const corrupt = new OmpSessionCatalog({ get: async () => '{', set: async () => undefined });
		await corrupt.load();
		expect(corrupt.entries()).toEqual([]);

		const oversized = new OmpSessionCatalog({
			get: async () => 'x'.repeat(128 * 1024 + 1),
			set: async () => undefined,
		});
		await oversized.load();
		expect(oversized.entries()).toEqual([]);

		await catalog.sync({ sessionId: 'pathless', sessionName: 'Pathless' });
		expect(catalog.sessionPath('pathless')).toBeUndefined();
	});

	it('bounds persistence to the most recent 100 sessions and degrades when storage is unavailable', async () => {
		const writes: string[] = [];
		let time = 0;
		const catalog = new OmpSessionCatalog(
			{
				get: async () => {
					throw new Error('unavailable');
				},
				set: async (_key: string, value: string) => void writes.push(value),
			},
			() => ++time
		);
		await catalog.load();
		for (let index = 0; index < MAX_OMP_SESSION_CATALOG_ENTRIES + 1; index += 1) {
			await catalog.sync({
				sessionId: `session-${index}`,
				sessionFile: `C:/private/${index}.jsonl`,
				sessionName: `Session ${index}`,
			});
		}
		expect(catalog.entries()).toHaveLength(MAX_OMP_SESSION_CATALOG_ENTRIES);
		expect(catalog.sessionPath('session-0')).toBeUndefined();
		expect(catalog.sessionPath('session-100')).toBe('C:/private/100.jsonl');
		expect(writes).not.toHaveLength(0);
	});
});
