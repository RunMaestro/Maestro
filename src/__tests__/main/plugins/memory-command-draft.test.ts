import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as codexMemory from '../../../main/agents/codex-memory';
import {
	MemoryCommandDraftService,
	type MemoryCommandDraftOwner,
} from '../../../main/plugins/memory-command-draft';
import type { MemoryCommandSelection } from '../../../shared/memoryCommandDraft';

vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile) };
});

const owner: MemoryCommandDraftOwner = {
	hostClientId: 'client',
	viewerId: 'viewer',
	pluginId: 'plugin',
};
const generator = {
	agentId: 'generator',
	provider: 'codex' as const,
	model: 'stored-model',
	effort: 'high',
};
const draft = {
	command: 'synthetic-command',
	description: 'Synthetic description',
	prompt: 'Synthetic prompt',
};
const prefix = 'SYNTHETIC LEFT\r\n';
const chosen = '😀chosen\r\nline';
const original = prefix + chosen + '\r\nSYNTHETIC RIGHT';
let fixture: string;
let selection: MemoryCommandSelection;
let service: MemoryCommandDraftService;
let allowed: ReturnType<typeof vi.fn>;
let getSource: ReturnType<typeof vi.fn>;
let getGenerator: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	fixture = await fs.mkdtemp(path.join(process.cwd(), '.memory-command-test-'));
	await fs.mkdir(path.join(fixture, 'memories'));
	await fs.writeFile(path.join(fixture, 'memories', 'MEMORY.md'), original);
	selection = {
		sourceRef: {
			sourceAgentId: 'source',
			provider: 'codex',
			location: { kind: 'local' },
			codexHome: fixture,
			memoryRoot: path.join(fixture, 'memories'),
			relativePath: 'MEMORY.md',
		},
		textSnapshot: original,
		dirty: true,
		selection: { start: prefix.length, end: prefix.length + chosen.length },
		requestId: 'renderer-provisional-id',
		status: 'selected',
		generator: { ...generator, model: 'untrusted-renderer-model', effort: 'untrusted-effort' },
	};
	allowed = vi.fn(() => true);
	getSource = vi.fn((id: string) =>
		id === 'source'
			? {
					sourceAgentId: id,
					codexHome: fixture,
				}
			: undefined
	);
	getGenerator = vi.fn((id: string) => (id === generator.agentId ? generator : undefined));
	service = new MemoryCommandDraftService({ getSource, getGenerator, isAllowed: allowed });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(fixture, { recursive: true, force: true });
});

async function register() {
	return (await service.register(owner, selection)).requestId;
}

async function running() {
	const id = await register();
	const { controller } = await service.start(owner.pluginId, id, generator.agentId);
	return { id, controller };
}

/** Inspect retained memory only to prove erasure/quotas without introducing a production debug API. */
function retained() {
	return (service as unknown as { requests: Map<string, unknown> }).requests;
}

describe('host-bound memory command draft requests', () => {
	it('issues main IDs, releases only the exact UTF-16 selection and never rereads or writes text', async () => {
		const read = vi.mocked(fs.readFile).mockClear();
		const write = vi.mocked(fs.writeFile).mockClear();
		const before = structuredClone(selection);
		const id = await register();
		expect(id).toMatch(/^[a-f0-9-]{36}$/);
		expect(id).not.toBe(selection.requestId);
		expect(await service.get(owner.pluginId, id)).toEqual({
			requestId: id,
			sourceRef: before.sourceRef,
			text: chosen,
			dirty: true,
			generatorAgentId: generator.agentId,
		});
		expect(service.getStatus(owner, id)).toEqual({ requestId: id, status: 'selected' });
		expect(JSON.stringify([...retained().values()])).not.toContain(prefix);
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(selection).toEqual(before);
		read.mockRestore();
		expect(await fs.readFile(path.join(fixture, 'memories', 'MEMORY.md'), 'utf8')).toBe(original);
	});

	it.each([undefined, { start: 0, end: 0 }, { start: prefix.length, end: prefix.length }])(
		'releases the whole dirty snapshot for an absent or empty selection %j',
		async (range) => {
			selection.selection = range;
			selection.textSnapshot = original + '\r\nUNSAVED';
			const id = await register();
			expect((await service.get(owner.pluginId, id)).text).toBe(selection.textSnapshot);
		}
	);

	it('detaches all input/output references and uses current host generator configuration', async () => {
		const id = await register();
		selection.textSnapshot = 'changed';
		selection.sourceRef.memoryRoot = '/forged';
		selection.generator.agentId = 'other';
		const snapshot = await service.get(owner.pluginId, id);
		snapshot.sourceRef.codexHome = '/changed';
		expect((await service.get(owner.pluginId, id)).text).toBe(chosen);
		getGenerator.mockReturnValue({ ...generator, model: 'changed-stored-model' });
		expect((await service.start(owner.pluginId, id, generator.agentId)).generator.model).toBe(
			'changed-stored-model'
		);
		expect(allowed).toHaveBeenCalledWith({
			...owner,
			sourceAgentId: 'source',
			generatorAgentId: 'generator',
		});
	});

	it.each([
		[
			'unknown top-level field',
			(value: Record<string, unknown>) => {
				value.extra = 'private';
			},
		],
		[
			'wrong status',
			(value: Record<string, unknown>) => {
				value.status = 'generating';
			},
		],
		[
			'nonboolean dirty',
			(value: Record<string, unknown>) => {
				value.dirty = 'yes';
			},
		],
		[
			'missing generator',
			(value: Record<string, unknown>) => {
				delete value.generator;
			},
		],
		[
			'null selection',
			(value: Record<string, unknown>) => {
				value.selection = null;
			},
		],
		[
			'non-string text',
			(value: Record<string, unknown>) => {
				value.textSnapshot = 12;
			},
		],
	])('rejects closed-schema violation: %s', async (_name, mutate) => {
		const raw = structuredClone(selection) as unknown as Record<string, unknown>;
		mutate(raw);
		await expect(service.register(owner, raw)).rejects.toThrow('MemoryCommandInvalid');
		expect(retained().size).toBe(0);
	});

	it.each([
		{ start: -1, end: 1 },
		{ start: 0, end: 1e6 },
		{ start: 4, end: 3 },
		{ start: 0.5, end: 1 },
		{ start: NaN, end: 1 },
		{ start: prefix.length + 1, end: prefix.length + 2 },
		{ start: prefix.length, end: prefix.length + 1 },
		{ start: 0, end: 1, extra: true },
	])('rejects invalid UTF-16 selection %j', async (range) => {
		await expect(service.register(owner, { ...selection, selection: range })).rejects.toThrow(
			'MemoryCommandInvalid'
		);
	});

	it('checks the full UTF-8 snapshot before slicing and accepts exactly 128 KiB', async () => {
		await expect(
			service.register(owner, {
				...selection,
				textSnapshot: 'é'.repeat(65537),
				selection: { start: 0, end: 1 },
			})
		).rejects.toThrow('MemoryCommandInvalid');
		const accepted = await service.register(owner, {
			...selection,
			textSnapshot: 'é'.repeat(65536),
			selection: { start: 0, end: 1 },
		});
		expect((await service.get(owner.pluginId, accepted.requestId)).text).toBe('é');
	});

	it.each([
		{ codexHome: '/forged' },
		{ memoryRoot: '/forged' },
		{ sourceAgentId: 'other' },
		{ relativePath: '../MEMORY.md' },
		{ relativePath: '/MEMORY.md' },
		{ relativePath: 'missing.md' },
		{ relativePath: 'directory.md' },
		{ provider: 'claude-code' },
		{ location: { kind: 'ssh', remoteId: 'remote' } },
		{ location: { kind: 'local', extra: true } },
		{ extra: 'forged' },
	])('rejects forged, stale or unsupported source %j', async (patch) => {
		await fs.mkdir(path.join(fixture, 'memories', 'directory.md'));
		await expect(
			service.register(owner, { ...selection, sourceRef: { ...selection.sourceRef, ...patch } })
		).rejects.toThrow(/MemoryCommand/);
		expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
	});

	it('rejects source symlink escape and remote session identity without a local fallback', async () => {
		await fs.writeFile(path.join(fixture, 'outside.md'), 'SYNTHETIC OUTSIDE');
		await fs.symlink(path.join(fixture, 'outside.md'), path.join(fixture, 'memories', 'escape.md'));
		await expect(
			service.register(owner, {
				...selection,
				sourceRef: { ...selection.sourceRef, relativePath: 'escape.md' },
			})
		).rejects.toThrow('MemoryCommandUnavailable');
		getSource.mockReturnValue({
			sourceAgentId: 'source',
			codexHome: '/synthetic/home',
			remoteId: 'remote',
		});
		await expect(register()).rejects.toThrow('MemoryCommandUnavailable');
	});

	it.each([
		undefined,
		{ ...generator, provider: 'claude-code' },
		{ ...generator, agentId: 'other' },
	])('rejects absent or rebound generator configuration %j', async (config) => {
		getGenerator.mockReturnValue(config);
		await expect(register()).rejects.toThrow('MemoryCommandUnavailable');
	});

	it('hides raw source resolver errors and rejects missing active plugin/host grants', async () => {
		getSource.mockImplementationOnce(() => {
			throw new Error(original);
		});
		await expect(register()).rejects.toThrow(/^MemoryCommandUnavailable$/);
		allowed.mockReturnValue(false);
		await expect(register()).rejects.toThrow(/^MemoryCommandUnavailable$/);
		expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
	});

	it('treats foreign and absent plugin/generator/client/viewer IDs identically', async () => {
		const id = await register();
		await expect(service.get('other', id)).rejects.toThrow(/^MemoryCommandInvalid$/);
		await expect(service.get(owner.pluginId, 'missing')).rejects.toThrow(/^MemoryCommandInvalid$/);
		await expect(service.start(owner.pluginId, id, 'other')).rejects.toThrow(
			/^MemoryCommandInvalid$/
		);
		expect(() => service.cancel(owner.pluginId, id, 'other')).toThrow(/^MemoryCommandInvalid$/);
		expect(() => service.cancel('other', id, generator.agentId)).toThrow(/^MemoryCommandInvalid$/);
		for (const changed of [
			{ hostClientId: 'other' },
			{ viewerId: 'other' },
			{ pluginId: 'other' },
		]) {
			expect(() => service.getStatus({ ...owner, ...changed }, id)).toThrow(
				/^MemoryCommandInvalid$/
			);
			expect(() => service.cancelForHost({ ...owner, ...changed }, id)).toThrow(
				/^MemoryCommandInvalid$/
			);
		}
		expect(service.getStatus(owner, id).status).toBe('selected');
	});

	it('allows only one simultaneous start, rejects replays, and retains the winning run', async () => {
		const id = await register();
		// Both nested live checks resolve in the same microtask turn, before either caller resumes.
		vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef').mockResolvedValue(selection.sourceRef);
		const starts = await Promise.allSettled([
			service.start(owner.pluginId, id, generator.agentId),
			service.start(owner.pluginId, id, generator.agentId),
		]);
		expect(starts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
		expect(service.getStatus(owner, id).status).toBe('generating');
		await expect(service.get(owner.pluginId, id)).rejects.toThrow('MemoryCommandInvalid');
		await expect(service.start(owner.pluginId, id, generator.agentId)).rejects.toThrow(
			'MemoryCommandInvalid'
		);
	});

	it('cancels synchronously, clears text before abort callbacks, and ignores a late result', async () => {
		const { id, controller } = await running();
		const onAbort = vi.fn(() => {
			expect(service.getStatus(owner, id).status).toBe('cancelled');
			expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
		});
		controller.signal.addEventListener('abort', onAbort);
		allowed.mockReturnValue(false);
		expect(service.cancelForHost(owner, id)).toBe(true);
		expect(onAbort).toHaveBeenCalledOnce();
		expect(service.cancel(owner.pluginId, id, generator.agentId)).toBe(false);
		expect(await service.complete(owner.pluginId, id, controller, draft)).toBe(false);
		expect(service.getStatus(owner, id).status).toBe('cancelled');
	});

	it('observes aborts from the existing runner cleanup controller', async () => {
		const { id, controller } = await running();
		controller.abort();
		expect(service.getStatus(owner, id).status).toBe('cancelled');
		expect(await service.complete(owner.pluginId, id, controller, draft)).toBe(false);
	});

	it('replaces one viewer request while keeping other clients and viewers independent', async () => {
		const { id, controller } = await running();
		const otherClient = { ...owner, hostClientId: 'other-client' };
		const otherViewer = { ...owner, viewerId: 'other-viewer' };
		const a = await service.register(otherClient, selection);
		const b = await service.register(otherViewer, selection);
		const next = await register();
		expect(controller.signal.aborted).toBe(true);
		expect(service.getStatus(owner, id).status).toBe('cancelled');
		expect(service.getStatus(owner, next).status).toBe('selected');
		expect(service.getStatus(otherClient, a.requestId).status).toBe('selected');
		expect(service.getStatus(otherViewer, b.requestId).status).toBe('selected');
	});

	it('checks live source/home identity again without replacing the dirty text', async () => {
		const id = await register();
		await fs.rename(
			path.join(fixture, 'memories', 'MEMORY.md'),
			path.join(fixture, 'memories', 'removed.md')
		);
		await expect(service.get(owner.pluginId, id)).rejects.toThrow('MemoryCommandUnavailable');
		expect(service.getStatus(owner, id).status).toBe('error');
		await fs.rename(
			path.join(fixture, 'memories', 'removed.md'),
			path.join(fixture, 'memories', 'MEMORY.md')
		);
		const next = await register();
		getSource.mockReturnValue({
			sourceAgentId: 'source',
			codexHome: path.join(fixture, 'other-home'),
		});
		await expect(service.start(owner.pluginId, next, generator.agentId)).rejects.toThrow(
			'MemoryCommandUnavailable'
		);
	});

	it('invalidates a silent completed run on revoke and never resurrects it when grants return', async () => {
		const { id, controller } = await running();
		allowed.mockReturnValue(false);
		expect(await service.complete(owner.pluginId, id, controller, draft)).toBe(false);
		expect(controller.signal.aborted).toBe(true);
		expect(service.getStatus(owner, id).status).toBe('error');
		allowed.mockReturnValue(true);
		expect(await service.complete(owner.pluginId, id, controller, draft)).toBe(false);
	});

	it('does not expose a snapshot when cancellation happens during its asynchronous live check', async () => {
		const id = await register();
		let release!: (ref: MemoryCommandSelection['sourceRef']) => void;
		vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef').mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const pending = service.get(owner.pluginId, id);
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		service.cancelForHost(owner, id);
		release(selection.sourceRef);
		await expect(pending).rejects.toThrow('MemoryCommandInvalid');
		expect(service.getStatus(owner, id).status).toBe('cancelled');
	});

	it.each(['grant', 'source'] as const)(
		'rechecks %s identity after asynchronous resolution',
		async (changed) => {
			const id = await register();
			let release!: (ref: MemoryCommandSelection['sourceRef']) => void;
			vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef').mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					})
			);
			const pending = service.get(owner.pluginId, id);
			await vi.waitFor(() => expect(release).toBeTypeOf('function'));
			if (changed === 'grant') allowed.mockReturnValue(false);
			else
				getSource.mockReturnValue({
					sourceAgentId: 'source',
					remoteId: 'remote',
					codexHome: '/synthetic/home',
				});
			release(selection.sourceRef);
			await expect(pending).rejects.toThrow('MemoryCommandUnavailable');
			expect(service.getStatus(owner, id).status).toBe('error');
		}
	);

	it('lets a replacement win while the previous registration is still resolving', async () => {
		let release!: (ref: MemoryCommandSelection['sourceRef']) => void;
		vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef').mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const first = service.register(owner, selection);
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		const second = await service.register(owner, selection);
		release(selection.sourceRef);
		await expect(first).rejects.toThrow('MemoryCommandInvalid');
		expect(service.getStatus(owner, second.requestId).status).toBe('selected');
	});

	it('invalidates an unfinished registration when the host client disappears', async () => {
		let release!: (ref: MemoryCommandSelection['sourceRef']) => void;
		vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef').mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const pending = service.register(owner, selection);
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		service.cleanupClient(owner.hostClientId);
		release(selection.sourceRef);
		await expect(pending).rejects.toThrow('MemoryCommandInvalid');
		expect(retained().size).toBe(0);
	});

	it('rechecks cancellation after asynchronously resolving the provider environment', async () => {
		let release!: (source: unknown) => void;
		getSource.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const resolver = vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef');
		const pending = service.register(owner, selection);
		service.closeViewer(owner.hostClientId, owner.viewerId);
		release({ sourceAgentId: 'source', codexHome: fixture });
		await expect(pending).rejects.toThrow('MemoryCommandUnavailable');
		expect(resolver).not.toHaveBeenCalled();
		expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
	});

	it('keeps exactly one validated draft, claims preview once, and saves only through its host owner', async () => {
		const { id, controller } = await running();
		await expect(
			service.complete(owner.pluginId, id, new AbortController(), draft)
		).rejects.toThrow('MemoryCommandInvalid');
		const mutable = { ...draft };
		expect(await service.complete(owner.pluginId, id, controller, mutable)).toBe(true);
		mutable.prompt = 'forged';
		expect(service.getStatus(owner, id).status).toBe('ready');
		expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
		await expect(service.preview(owner.pluginId, id, mutable)).rejects.toThrow(
			'MemoryCommandInvalid'
		);
		await expect(service.complete(owner.pluginId, id, controller, draft)).rejects.toThrow(
			'MemoryCommandInvalid'
		);
		vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef').mockResolvedValue(selection.sourceRef);
		const previews = await Promise.allSettled([
			service.preview(owner.pluginId, id, draft),
			service.preview(owner.pluginId, id, draft),
		]);
		expect(previews.filter((value) => value.status === 'fulfilled')).toEqual([
			{ status: 'fulfilled', value: { owner, draft } },
		]);
		expect(service.getStatus(owner, id).status).toBe('preview');
		expect(JSON.stringify([...retained().values()])).not.toContain(draft.prompt);
		await expect(service.save({ ...owner, hostClientId: 'other' }, id, () => true)).rejects.toThrow(
			'MemoryCommandInvalid'
		);
		expect(await service.save(owner, id, () => true)).toBe(true);
		expect(service.cancelForHost(owner, id)).toBe(false);
		expect(service.getStatus(owner, id).status).toBe('saved');
	});

	it.each(['cancel', 'revoke', 'plugin', 'client'] as const)(
		'refuses persistence after %s invalidates a preview',
		async (action) => {
			const { id, controller } = await running();
			await service.complete(owner.pluginId, id, controller, draft);
			await service.preview(owner.pluginId, id, draft);
			if (action === 'cancel') service.cancelForHost(owner, id);
			if (action === 'revoke') allowed.mockReturnValue(false);
			if (action === 'plugin') service.cleanupPlugin(owner.pluginId);
			if (action === 'client') service.cleanupClient(owner.hostClientId);
			const persist = vi.fn(() => true);
			await expect(service.save(owner, id, persist)).rejects.toThrow();
			expect(persist).not.toHaveBeenCalled();
		}
	);

	it('rejects duplicate saves during validation and cancellation before the commit point', async () => {
		const { id, controller } = await running();
		await service.complete(owner.pluginId, id, controller, draft);
		await service.preview(owner.pluginId, id, draft);
		let resolve!: (source: ReturnType<typeof getSource>) => void;
		getSource.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		const persist = vi.fn(() => true);
		const pending = service.save(owner, id, persist);
		await expect(service.save(owner, id, persist)).rejects.toThrow('MemoryCommandInvalid');
		service.cancelForHost(owner, id);
		resolve(getSource());
		await expect(pending).rejects.toThrow();
		expect(persist).not.toHaveBeenCalled();
		expect(service.getStatus(owner, id).status).toBe('cancelled');
	});

	it.each(['cancel', 'plugin', 'client'] as const)(
		'keeps an authorized successful write saved after %s during persistence',
		async (action) => {
			const { id, controller } = await running();
			await service.complete(owner.pluginId, id, controller, draft);
			await service.preview(owner.pluginId, id, draft);
			let finish!: (value: boolean) => void;
			const persist = vi.fn(
				() =>
					new Promise<boolean>((done) => {
						finish = done;
					})
			);
			const pending = service.save(owner, id, persist);
			await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
			expect(service.getStatus(owner, id).status).toBe('saving');
			if (action === 'cancel') service.cancelForHost(owner, id);
			if (action === 'plugin') service.cleanupPlugin(owner.pluginId);
			if (action === 'client') service.cleanupClient(owner.hostClientId);
			allowed.mockReturnValue(false);
			await expect(service.save(owner, id, persist)).rejects.toThrow('MemoryCommandInvalid');
			finish(true);
			expect(await pending).toBe(true);
			expect(service.getStatus(owner, id).status).toBe('saved');
			expect(service.cancelForHost(owner, id)).toBe(false);
			await expect(service.save(owner, id, persist)).rejects.toThrow('MemoryCommandInvalid');
			expect(persist).toHaveBeenCalledOnce();
		}
	);

	it('keeps false and rejected persistence retryable, but never retries an abandoned write', async () => {
		const { id, controller } = await running();
		await service.complete(owner.pluginId, id, controller, draft);
		await service.preview(owner.pluginId, id, draft);
		expect(await service.save(owner, id, () => false)).toBe(false);
		expect(service.getStatus(owner, id).status).toBe('preview');
		await expect(service.save(owner, id, () => Promise.reject(new Error('disk')))).rejects.toThrow(
			'disk'
		);
		expect(service.getStatus(owner, id).status).toBe('preview');
		expect(
			await service.save(owner, id, () => {
				service.closeViewer(owner.hostClientId, owner.viewerId);
				return false;
			})
		).toBe(false);
		expect(service.getStatus(owner, id).status).toBe('cancelled');
	});

	it('does not let a stale asynchronous preview check terminalize an authorized save', async () => {
		const { id, controller } = await running();
		await service.complete(owner.pluginId, id, controller, draft);
		await service.preview(owner.pluginId, id, draft);
		let resolveRead!: (source: undefined) => void;
		getSource.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRead = resolve;
				})
		);
		const stale = service.getPreview(owner, id);
		let finish!: (value: boolean) => void;
		const persist = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				})
		);
		const pending = service.save(owner, id, persist);
		await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
		resolveRead(undefined);
		await expect(stale).rejects.toThrow();
		expect(service.getStatus(owner, id).status).toBe('saving');
		finish(true);
		expect(await pending).toBe(true);
		expect(service.getStatus(owner, id).status).toBe('saved');
	});

	it.each([
		null,
		[],
		{},
		{ ...draft, extra: 'x' },
		{ ...draft, prompt: '' },
		{ ...draft, command: 'x'.repeat(257) },
		{ ...draft, description: 'x'.repeat(4097) },
		{ ...draft, prompt: 'é'.repeat(65537) },
	])(
		'rejects invalid completion fields and immediately erases retained text (case %#)',
		async (response) => {
			const { id, controller } = await running();
			await expect(service.complete(owner.pluginId, id, controller, response)).rejects.toThrow(
				'MemoryCommandInvalid'
			);
			expect(service.getStatus(owner, id).status).toBe('error');
			expect(controller.signal.aborted).toBe(true);
			expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
		}
	);

	it('handles timeout/error and viewer close without a timer or a runner call', async () => {
		const { id, controller } = await running();
		service.fail(owner, id);
		service.fail(owner, id);
		expect(controller.signal.aborted).toBe(true);
		expect(service.getStatus(owner, id).status).toBe('error');
		const next = await running();
		service.closeViewer(owner.hostClientId, owner.viewerId);
		expect(next.controller.signal.aborted).toBe(true);
		expect(service.getStatus(owner, next.id).status).toBe('cancelled');
	});

	it.each(['plugin', 'client'] as const)(
		'purges all owned texts/tombstones on %s cleanup',
		async (kind) => {
			const old = await register();
			service.cancelForHost(owner, old);
			const { id, controller } = await running();
			const other = { ...owner, pluginId: 'other', hostClientId: 'other' };
			const unaffected = await service.register(other, selection);
			if (kind === 'plugin') service.cleanupPlugin(owner.pluginId);
			else service.cleanupClient(owner.hostClientId);
			expect(controller.signal.aborted).toBe(true);
			expect(() => service.getStatus(owner, id)).toThrow('MemoryCommandInvalid');
			expect(() => service.getStatus(owner, old)).toThrow('MemoryCommandInvalid');
			await expect(service.complete(owner.pluginId, id, controller, draft)).rejects.toThrow(
				'MemoryCommandInvalid'
			);
			expect(service.getStatus(other, unaffected.requestId).status).toBe('selected');
		}
	);

	it('caps active registrations, including pending work, at 32 and permits replacement at capacity', async () => {
		let release!: (ref: MemoryCommandSelection['sourceRef']) => void;
		const pending = new Promise<MemoryCommandSelection['sourceRef']>((resolve) => {
			release = resolve;
		});
		const resolver = vi.spyOn(codexMemory, 'resolveCodexMemorySourceRef').mockReturnValue(pending);
		const registrations = Array.from({ length: 32 }, (_, index) =>
			service.register({ ...owner, viewerId: String(index) }, selection)
		);
		await expect(service.register(owner, selection)).rejects.toThrow('MemoryCommandBusy');
		release(selection.sourceRef);
		await Promise.all(registrations);
		resolver.mockRestore();
		await expect(service.register({ ...owner, viewerId: '0' }, selection)).resolves.toMatchObject({
			status: 'selected',
		});
		service.closeViewer(owner.hostClientId, '1');
		await expect(service.register(owner, selection)).resolves.toMatchObject({ status: 'selected' });
	});

	it('retains at most the last 64 text-free terminal IDs per plugin', async () => {
		const ids: string[] = [];
		for (let index = 0; index < 66; index++) {
			const id = await register();
			ids.push(id);
			service.cancelForHost(owner, id);
		}
		expect(retained().size).toBe(64);
		expect(() => service.getStatus(owner, ids[1])).toThrow('MemoryCommandInvalid');
		expect(service.getStatus(owner, ids[2]).status).toBe('cancelled');
		expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
	});
});

describe('memory command source path identity', () => {
	let realHome: string;
	let aliasHome: string;
	let realRoot: string;

	beforeEach(async () => {
		realHome = path.join(fixture, 'Codex Account');
		aliasHome = path.join(fixture, 'CODEX~1');
		const root = path.join(realHome, 'memories');
		await fs.mkdir(path.join(root, 'rollout_summaries'), { recursive: true });
		await fs.writeFile(path.join(root, 'rollout_summaries', 'note.md'), original);
		// A directory alias exercises short/long root identity without faking the OS.
		await fs.symlink(realHome, aliasHome, 'junction');
		getSource.mockReturnValue({ sourceAgentId: 'source', codexHome: aliasHome });
		service = new MemoryCommandDraftService({
			getSource,
			getGenerator,
			isAllowed: allowed,
			retainPreview: () => true,
		});
		selection.sourceRef = (
			await codexMemory.readCodexMemory(getSource('source'), 'rollout_summaries/note.md')
		).sourceRef;
		realRoot = await fs.realpath(root);
	});

	it('registers and revalidates the reader identity through save using native nested paths', async () => {
		expect(selection.sourceRef).toEqual({
			sourceAgentId: 'source',
			provider: 'codex',
			location: { kind: 'local' },
			codexHome: aliasHome,
			memoryRoot: realRoot,
			relativePath: 'rollout_summaries/note.md',
		});
		expect(realRoot).not.toBe(path.join(aliasHome, 'memories'));
		const read = vi.mocked(fs.readFile).mockClear();
		const id = await register();
		await expect(service.get('foreign-plugin', id)).rejects.toThrow('MemoryCommandInvalid');
		expect(await service.get(owner.pluginId, id)).toMatchObject({
			sourceRef: selection.sourceRef,
			text: chosen,
		});
		const { controller } = await service.start(owner.pluginId, id, generator.agentId);
		expect(await service.complete(owner.pluginId, id, controller, draft)).toBe(true);
		await service.preview(owner.pluginId, id, draft);
		expect(await service.getPreview(owner, id)).toEqual(draft);
		const persist = vi.fn(() => true);
		expect(await service.save(owner, id, persist)).toBe(true);
		expect(persist).toHaveBeenCalledOnce();
		expect(service.getStatus(owner, id).status).toBe('saved');
		expect(read).not.toHaveBeenCalled();
	});

	it('rejects a lexical alias in place of the confirmed root at registration', async () => {
		selection.sourceRef.memoryRoot = path.join(aliasHome, 'memories');
		await expect(register()).rejects.toThrow('MemoryCommandUnavailable');
		expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
	});

	it.each(['get', 'start', 'complete', 'preview', 'getPreview', 'save'] as const)(
		'rejects an alias rebound to another account during %s',
		async (stage) => {
			const id = await register();
			const controller =
				stage === 'get' || stage === 'start'
					? undefined
					: (await service.start(owner.pluginId, id, generator.agentId)).controller;
			if (stage === 'preview' || stage === 'getPreview' || stage === 'save')
				await service.complete(owner.pluginId, id, controller!, draft);
			if (stage === 'getPreview' || stage === 'save')
				await service.preview(owner.pluginId, id, draft);

			const otherHome = path.join(fixture, 'Other Account');
			await fs.mkdir(path.join(otherHome, 'memories', 'rollout_summaries'), { recursive: true });
			await fs.writeFile(
				path.join(otherHome, 'memories', 'rollout_summaries', 'note.md'),
				original
			);
			await fs.unlink(aliasHome);
			await fs.symlink(otherHome, aliasHome, 'junction');
			const persist = vi.fn(() => true);
			if (stage === 'complete') {
				expect(await service.complete(owner.pluginId, id, controller!, draft)).toBe(false);
			} else {
				const actions = {
					get: () => service.get(owner.pluginId, id),
					start: () => service.start(owner.pluginId, id, generator.agentId),
					preview: () => service.preview(owner.pluginId, id, draft),
					getPreview: () => service.getPreview(owner, id),
					save: () => service.save(owner, id, persist),
				};
				await expect(actions[stage]()).rejects.toThrow('MemoryCommandUnavailable');
			}
			expect(service.getStatus(owner, id).status).toBe('error');
			expect(persist).not.toHaveBeenCalled();
			if (controller) expect(controller.signal.aborted).toBe(true);
			expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
		}
	);

	it.each(['register', 'get'] as const)(
		'rejects a different configured home sharing the same real root during %s',
		async (stage) => {
			const id = stage === 'get' ? await register() : undefined;
			getSource.mockReturnValue({ sourceAgentId: 'source', codexHome: realHome });
			expect(
				(
					await codexMemory.resolveCodexMemorySourceRef(
						getSource('source'),
						selection.sourceRef.relativePath
					)
				).memoryRoot
			).toBe(realRoot);
			await expect(id ? service.get(owner.pluginId, id) : register()).rejects.toThrow(
				'MemoryCommandUnavailable'
			);
			expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
		}
	);

	it.each(['register', 'get'] as const)(
		'rejects a nested alias escaping into a sibling-prefix root during %s',
		async (stage) => {
			const id = stage === 'get' ? await register() : undefined;
			const outside = realRoot + '-other';
			await fs.mkdir(outside);
			await fs.writeFile(path.join(outside, 'note.md'), original);
			const nested = path.join(realRoot, 'rollout_summaries');
			await fs.rename(nested, path.join(realRoot, 'retained'));
			await fs.symlink(outside, nested, 'junction');
			await expect(id ? service.get(owner.pluginId, id) : register()).rejects.toThrow(
				'MemoryCommandUnavailable'
			);
			expect(JSON.stringify([...retained().values()])).not.toContain(chosen);
		}
	);
});
