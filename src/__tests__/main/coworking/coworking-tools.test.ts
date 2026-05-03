import { describe, it, expect, beforeEach } from 'vitest';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';
import { listTerminals, readTerminal } from '../../../main/coworking/coworking-tools';

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
		registry.setActiveSession('sess-1');
	});

	it('listTerminals returns the active-session entries', () => {
		const out = listTerminals(registry);
		expect(out.terminals).toEqual([{ id: 'term:1', cwd: '/home/user/proj', title: 'Terminal 1' }]);
	});

	it('readTerminal returns the buffer when the resolver provides it', async () => {
		const out = await readTerminal(
			{ id: 'term:1' },
			{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
		);
		expect(out.id).toBe('term:1');
		expect(out.content).toBe('$ ls\nfoo\nbar\n');
		expect(out.truncated).toBe(false);
		expect(out.totalLines).toBeGreaterThan(0);
	});

	it('readTerminal tail-truncates when lines is set and exceeded', async () => {
		const buf = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
		const out = await readTerminal(
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
			{ id: 'term:1', lines: 10 },
			{ registry, resolver: async () => buf }
		);
		expect(out.truncated).toBe(false);
		expect(out.content).toBe(buf);
	});

	it('treats a single trailing newline as a terminator, not a line', async () => {
		// Without the fix this would report totalLines=4 and `lines: 3` would tail-trim
		// to "foo\nbar\n" + a synthetic empty line.
		const out = await readTerminal(
			{ id: 'term:1' },
			{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
		);
		expect(out.totalLines).toBe(3);
		const tailed = await readTerminal(
			{ id: 'term:1', lines: 2 },
			{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
		);
		expect(tailed.totalLines).toBe(3);
		expect(tailed.content).toBe('foo\nbar');
	});

	it('reports zero lines for an empty buffer', async () => {
		const out = await readTerminal({ id: 'term:1' }, { registry, resolver: async () => '' });
		expect(out.totalLines).toBe(0);
		expect(out.content).toBe('');
		expect(out.truncated).toBe(false);
	});

	it('readTerminal throws on unknown id', async () => {
		await expect(
			readTerminal({ id: 'term:99' }, { registry, resolver: async () => 'irrelevant' })
		).rejects.toThrow(/term:99/);
	});

	it('readTerminal throws when resolver is not configured', async () => {
		await expect(readTerminal({ id: 'term:1' }, { registry })).rejects.toThrow(
			/resolver not configured/
		);
	});
});
