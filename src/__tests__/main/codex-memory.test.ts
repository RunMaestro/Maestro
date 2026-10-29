import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { readCodexMemory, createCodexMemorySourceResolver } from '../../main/agents/codex-memory';
import { memoryLayoutFor } from '../../main/memory-manager';
import type { SessionInfo } from '../../shared/types';

vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		readFile: vi.fn(actual.readFile),
	};
});

let fixture: string;
beforeEach(async () => {
	fixture = await fs.mkdtemp(path.join(process.cwd(), '.codex-memory-test-'));
});
afterEach(async () => {
	await fs.rm(fixture, { recursive: true, force: true });
});

describe('Codex memory sources', () => {
	it('uses the canonical viewer resolver and rejects translated project stores', async () => {
		const session = { id: 'source', toolType: 'codex', cwd: fixture } as SessionInfo;
		const resolveLayout = vi.fn(async () =>
			memoryLayoutFor('codex', { projectPath: fixture, accountDir: fixture })
		);
		const resolveSource = createCodexMemorySourceResolver(() => session, resolveLayout);
		expect(await resolveSource('source')).toEqual({ sourceAgentId: 'source', codexHome: fixture });
		expect(resolveLayout).toHaveBeenCalledWith({
			agentId: 'source',
			toolType: 'codex',
			projectPath: fixture,
		});
		resolveLayout.mockResolvedValueOnce(
			memoryLayoutFor('claude-code', { projectPath: fixture, accountDir: fixture })
		);
		await expect(resolveSource('source')).rejects.toThrow('Codex account memory required');
		resolveLayout.mockRejectedValueOnce(new Error('SSH remote'));
		await expect(resolveSource('source')).rejects.toThrow('SSH remote');
		await expect(
			createCodexMemorySourceResolver(() => undefined, resolveLayout)('missing')
		).rejects.toThrow('source agent not found');
	});
	it('reads nested markdown under a symlinked root, preserving bytes and identity', async () => {
		const home = path.join(fixture, 'home');
		const root = path.join(fixture, 'real');
		await fs.mkdir(path.join(root, 'rollout_summaries'), { recursive: true });
		await fs.mkdir(home);
		const bytes = '# Synthetic\r\n[[nested]]\n';
		await fs.writeFile(path.join(root, 'rollout_summaries', 'one.md'), bytes);
		await fs.symlink(root, path.join(home, 'memories'));
		const source = { sourceAgentId: 'one', codexHome: home };
		const read = await readCodexMemory(source, 'rollout_summaries/one.md');
		expect(read.content).toBe(bytes);
		expect(read.sourceRef).toMatchObject({
			sourceAgentId: 'one',
			memoryRoot: root,
			relativePath: 'rollout_summaries/one.md',
		});
		expect(await fs.readFile(path.join(root, 'rollout_summaries', 'one.md'), 'utf8')).toBe(bytes);
		expect(
			(await readCodexMemory({ ...source, sourceAgentId: 'two' }, 'rollout_summaries/one.md'))
				.sourceRef.sourceAgentId
		).toBe('two');
	});
	it('keeps distinct source homes apart and reports inaccessible roots', async () => {
		const a = path.join(fixture, 'a');
		const b = path.join(fixture, 'b');
		await fs.mkdir(path.join(a, 'memories'), { recursive: true });
		await fs.mkdir(path.join(b, 'memories'), { recursive: true });
		await fs.writeFile(path.join(a, 'memories', 'a.md'), 'A');
		await fs.writeFile(path.join(b, 'memories', 'b.md'), 'B');
		const source = (id: string, home: string) => ({
			sourceAgentId: id,
			codexHome: home,
		});
		expect((await readCodexMemory(source('a', a), 'a.md')).content).toBe('A');
		expect((await readCodexMemory(source('b', b), 'b.md')).content).toBe('B');
		vi.mocked(fs.readFile).mockRejectedValueOnce(
			Object.assign(new Error('access denied'), { code: 'EACCES' })
		);
		await expect(readCodexMemory(source('b', b), 'b.md')).rejects.toMatchObject({ code: 'EACCES' });
		expect((await readCodexMemory(source('a', a), 'a.md')).content).toBe('A');
	});
	it('rejects traversal, outside symlinks and remote sources without local fallback', async () => {
		const home = path.join(fixture, 'home');
		await fs.mkdir(path.join(home, 'memories'), { recursive: true });
		await fs.writeFile(path.join(fixture, 'outside.md'), 'synthetic');
		await fs.symlink(path.join(fixture, 'outside.md'), path.join(home, 'memories', 'escape.md'));
		const source = { sourceAgentId: 'a', codexHome: home };
		for (const unsafe of [
			'../outside.md',
			'C:outside.md',
			'nested/../outside.md',
			'.. /outside.md',
			'nested\\one.md',
		])
			await expect(readCodexMemory(source, unsafe)).rejects.toThrow('Unsafe Codex memory path');
		await expect(readCodexMemory(source, 'escape.md')).rejects.toThrow('escapes root');
		await expect(readCodexMemory(source, 'missing.md')).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readCodexMemory({ ...source, remoteId: 'remote' }, 'escape.md')).rejects.toThrow(
			'Remote Codex memory'
		);
	});
});

it('reads nested files with native separators and rejects sibling-prefix symlinks', async () => {
	const home = path.join(fixture, 'account');
	const root = path.join(home, 'memories');
	await fs.mkdir(path.join(root, 'nested'), { recursive: true });
	await fs.writeFile(path.join(root, 'nested', 'note.md'), 'synthetic');
	expect(
		(await readCodexMemory({ sourceAgentId: 'source', codexHome: home }, 'nested/note.md')).content
	).toBe('synthetic');
	// On POSIX a backslash is part of the filename, not a separator. Normalizing it
	// would incorrectly accept this sibling; native containment must reject it.
	const outside = root + (process.platform === 'win32' ? '-other' : '\\other');
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, 'note.md'), 'outside');
	await fs.symlink(path.join(outside, 'note.md'), path.join(root, 'escape.md'));
	await expect(
		readCodexMemory({ sourceAgentId: 'source', codexHome: home }, 'escape.md')
	).rejects.toThrow('escapes root');
});
