import { describe, it, expect, beforeEach } from 'vitest';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';
import {
	listTerminals,
	readTerminal,
	MAX_TERMINAL_LINES,
} from '../../../main/coworking/coworking-tools';

describe('coworking-tools', () => {
	let registry: CoworkingRegistry;

	beforeEach(() => {
		registry = new CoworkingRegistry();
		registry.upsertTerminal({
			id: 'term:1',
			tabUuid: 'uuid-a',
			sessionId: 'sess-1',
			cwd: '/home/user/proj',
			title: 'Terminal 1',
		});
	});

	it('listTerminals returns entries scoped to the caller sessionId', () => {
		const out = listTerminals('sess-1', registry);
		expect(out.terminals).toEqual([{ id: 'term:1', cwd: '/home/user/proj', title: 'Terminal 1' }]);
	});

	it('listTerminals returns [] for a session with no records (even if the registry has others)', () => {
		expect(listTerminals('sess-other', registry).terminals).toEqual([]);
	});

	it('readTerminal returns the buffer when the resolver provides it', async () => {
		const out = await readTerminal(
			'sess-1',
			{ id: 'term:1' },
			{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
		);
		expect(out.id).toBe('term:1');
		expect(out.content).toBe('$ ls\nfoo\nbar\n');
		expect(out.truncated).toBe(false);
		expect(out.totalLines).toBeGreaterThan(0);
	});

	it('readTerminal forwards the caller sessionId into the resolver', async () => {
		let seenSession: string | null = null;
		await readTerminal(
			'sess-1',
			{ id: 'term:1' },
			{
				registry,
				resolver: async (sid) => {
					seenSession = sid;
					return 'ok';
				},
			}
		);
		expect(seenSession).toBe('sess-1');
	});

	it('readTerminal tail-truncates when lines is set and exceeded', async () => {
		const buf = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
		const out = await readTerminal(
			'sess-1',
			{ id: 'term:1', lines: 2 },
			{ registry, resolver: async () => buf }
		);
		expect(out.truncated).toBe(true);
		expect(out.content).toBe('l4\nl5');
		expect(out.totalLines).toBe(5);
	});

	it('readTerminal does not truncate when lines >= total', async () => {
		const buf = 'one\ntwo';
		const out = await readTerminal(
			'sess-1',
			{ id: 'term:1', lines: 10 },
			{ registry, resolver: async () => buf }
		);
		expect(out.truncated).toBe(false);
		expect(out.content).toBe(buf);
	});

	it('readTerminal clamps a requested line count to MAX_TERMINAL_LINES', async () => {
		// Buffer one line past the ceiling and ask for far more than the cap.
		// Without the clamp the whole buffer returns untruncated; the clamp forces
		// exactly MAX_TERMINAL_LINES tail lines back and flips truncated true.
		const total = MAX_TERMINAL_LINES + 1;
		const buf = Array.from({ length: total }, (_, i) => `l${i}`).join('\n');
		const out = await readTerminal(
			'sess-1',
			{ id: 'term:1', lines: MAX_TERMINAL_LINES * 5 },
			{ registry, resolver: async () => buf }
		);
		expect(out.truncated).toBe(true);
		expect(out.totalLines).toBe(total);
		expect(out.content.split('\n')).toHaveLength(MAX_TERMINAL_LINES);
		// Tail semantics: the oldest line (l0) is dropped, the newest retained.
		expect(out.content.split('\n')[0]).toBe('l1');
		expect(out.content.endsWith(`l${total - 1}`)).toBe(true);
	});

	it('treats a single trailing newline as a terminator, not a line', async () => {
		const out = await readTerminal(
			'sess-1',
			{ id: 'term:1' },
			{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
		);
		expect(out.totalLines).toBe(3);
		const tailed = await readTerminal(
			'sess-1',
			{ id: 'term:1', lines: 2 },
			{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
		);
		expect(tailed.totalLines).toBe(3);
		expect(tailed.content).toBe('foo\nbar');
	});

	it('reports zero lines for an empty buffer', async () => {
		const out = await readTerminal(
			'sess-1',
			{ id: 'term:1' },
			{ registry, resolver: async () => '' }
		);
		expect(out.totalLines).toBe(0);
		expect(out.content).toBe('');
		expect(out.truncated).toBe(false);
	});

	it('readTerminal throws on unknown id', async () => {
		await expect(
			readTerminal('sess-1', { id: 'term:99' }, { registry, resolver: async () => 'irrelevant' })
		).rejects.toThrow(/term:99/);
	});

	it("readTerminal cannot read another session's terminal even with a matching id", async () => {
		registry.upsertTerminal({
			id: 'term:1',
			tabUuid: 'uuid-foreign',
			sessionId: 'sess-other',
			cwd: '/other',
			title: 'Foreign Terminal 1',
		});
		// sess-1 has its own term:1 (uuid-a) - calling from sess-1 must resolve to uuid-a.
		let seenTab: string | null = null;
		const out = await readTerminal(
			'sess-1',
			{ id: 'term:1' },
			{
				registry,
				resolver: async (_sid, tabUuid) => {
					seenTab = tabUuid;
					return 'own';
				},
			}
		);
		expect(seenTab).toBe('uuid-a');
		expect(out.content).toBe('own');
		// And calling from a session that has no record at that id must throw.
		await expect(
			readTerminal('sess-empty', { id: 'term:1' }, { registry, resolver: async () => 'leak' })
		).rejects.toThrow(/term:1/);
	});

	it('readTerminal throws when resolver is not configured', async () => {
		await expect(readTerminal('sess-1', { id: 'term:1' }, { registry })).rejects.toThrow(
			/resolver not configured/
		);
	});
});
