/**
 * phaseGenerator.test.ts
 *
 * Unit tests for the phase generator service.
 * Tests parsing, validation, and document generation logic.
 *
 * IMPORTANT: These tests exist to catch regressions in document parsing logic.
 * The wizard dropdown should show ALL generated documents, not just one.
 * See: https://github.com/anthropics/maestro/issues/XXX
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	phaseGenerator,
	type GenerationConfig,
	parseGeneratedDocuments,
	splitIntoPhases,
	countTasks,
	validateDocuments,
	sanitizeFilename,
} from '../../../../../renderer/components/Wizard/services/phaseGenerator';
import { GROK_WIZARD_GENERATION_ARGS } from '../../../../../renderer/utils/grokWizard';

describe('Grok onboarding generation lifecycle', () => {
	const config: GenerationConfig = {
		agentType: 'grok',
		directoryPath: '/project',
		projectName: 'Project',
		conversationHistory: [],
	};
	const document =
		'---BEGIN DOCUMENT---\nFILENAME: Phase-01.md\nCONTENT:\n# Phase 1: Setup\n## Tasks\n- [ ] Build it\n---END DOCUMENT---';
	const native =
		JSON.stringify({ type: 'text', data: document }) +
		'\n{"type":"end","stopReason":"EndTurn","sessionId":"019f47fa-e297-7993-a1f6-adfaf940ba8c","requestId":"req-1"}\n';
	const ipc = {
		...window.maestro,
		agents: { ...window.maestro.agents, get: vi.fn() },
		process: {
			...window.maestro.process,
			spawn: vi.fn(),
			kill: vi.fn(),
			onData: vi.fn(),
			onExit: vi.fn(),
			onAgentError: vi.fn(),
		},
		autorun: {
			...window.maestro.autorun,
			watchFolder: vi.fn(),
			unwatchFolder: vi.fn(),
			onFileChanged: vi.fn(),
			listDocs: vi.fn(),
			readDoc: vi.fn(),
		},
	};
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.stubGlobal('window', { maestro: ipc });
		ipc.agents.get
			.mockReset()
			.mockResolvedValue({ id: 'grok', command: 'grok', args: [], available: true });
		ipc.process.spawn.mockReset().mockResolvedValue({ success: true });
		ipc.process.kill.mockReset().mockResolvedValue(undefined);
		for (const listener of [
			ipc.process.onData,
			ipc.process.onExit,
			ipc.process.onAgentError,
			ipc.autorun.onFileChanged,
		]) {
			listener.mockReset().mockImplementation(() => vi.fn());
		}
		ipc.autorun.watchFolder.mockReset().mockResolvedValue({ success: true });
		ipc.autorun.unwatchFolder.mockReset().mockResolvedValue({ success: true });
		ipc.autorun.listDocs.mockReset().mockResolvedValue({ success: true, files: [] });
		ipc.autorun.readDoc.mockReset().mockResolvedValue({ success: true, content: '' });
	});
	afterEach(() => {
		phaseGenerator.abort();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([
		['grok', document],
		['grok', native],
		['claude-code', document],
		['codex', document],
		['antigravity', document],
	] as const)(
		'generates a plan through the selected %s consumer (%#)',
		async (agentType, output) => {
			ipc.agents.get.mockResolvedValue({
				id: agentType,
				command: agentType,
				args: [],
				available: true,
			});
			const onComplete = vi.fn();
			const pending = phaseGenerator.generateDocuments({ ...config, agentType }, { onComplete });
			await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
			const spawn = ipc.process.spawn.mock.calls[0][0];
			expect(spawn).toMatchObject({
				toolType: agentType,
				command: agentType,
				cwd: config.directoryPath,
			});
			if (agentType === 'grok') {
				expect(spawn.args).toEqual(GROK_WIZARD_GENERATION_ARGS);
				expect(spawn).toMatchObject({ permissionMode: 'full' });
			} else expect(spawn.args).not.toContain('--no-subagents');
			ipc.process.onData.mock.calls[0][0](spawn.sessionId, output);
			ipc.process.onExit.mock.calls[0][0](spawn.sessionId, 0);
			expect(await pending).toMatchObject({
				success: true,
				documents: [{ filename: 'Phase-01.md', taskCount: 1 }],
			});
			expect(onComplete).toHaveBeenCalledOnce();
			expect(ipc.agents.get).toHaveBeenCalledExactlyOnceWith(agentType);
			expect(ipc.process.onData.mock.results[0].value).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each(['accepted', 'refused', 'missing', 'rejected'] as const)(
		'waits for the %s spawn receipt after an early valid exit',
		async (receipt) => {
			let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
			ipc.process.spawn.mockReturnValue(
				new Promise((yes, no) => {
					resolve = yes;
					reject = no;
				})
			);
			const onComplete = vi.fn();
			const pending = phaseGenerator.generateDocuments(config, { onComplete });
			await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
			const id = ipc.process.spawn.mock.calls[0][0].sessionId;
			ipc.process.onData.mock.calls[0][0](id, document);
			ipc.process.onExit.mock.calls[0][0](id, 0);
			await vi.advanceTimersByTimeAsync(0);
			expect(onComplete).not.toHaveBeenCalled();
			expect(phaseGenerator.isGenerationInProgress()).toBe(true);
			if (receipt === 'rejected') reject(new Error('missing executable'));
			else resolve(receipt === 'missing' ? {} : { success: receipt === 'accepted' });
			expect(await pending).toMatchObject({ success: receipt === 'accepted' });
			expect(onComplete).toHaveBeenCalledTimes(receipt === 'accepted' ? 1 : 0);
			expect(ipc.process.spawn).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each([
		['provider error', document, 0, undefined, 'Permission denied'],
		['nonzero exit', document, 2, undefined, undefined],
		['signal', document, 0, 15, undefined],
		[
			'incomplete native',
			JSON.stringify({ type: 'text', data: document }),
			0,
			undefined,
			undefined,
		],
		['native error', native.replace('EndTurn', 'Error'), 0, undefined, undefined],
	] as const)(
		'refuses %s without publishing a plan',
		async (_name, output, code, signal, error) => {
			const onComplete = vi.fn(),
				onError = vi.fn();
			const pending = phaseGenerator.generateDocuments(config, { onComplete, onError });
			await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
			const id = ipc.process.spawn.mock.calls[0][0].sessionId;
			ipc.process.onAgentError.mock.calls[0][0]('unrelated', { message: 'ignore' });
			ipc.process.onData.mock.calls[0][0](id, output);
			if (error) ipc.process.onAgentError.mock.calls[0][0](id, { message: error });
			ipc.process.onExit.mock.calls[0][0](id, code, signal);
			const result = await pending;
			expect(result).toMatchObject({ success: false, error: expect.any(String) });
			expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
			expect(onComplete).not.toHaveBeenCalled();
			expect(ipc.process.spawn).toHaveBeenCalledOnce();
			expect(ipc.process.onAgentError.mock.results[0].value).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('keeps a same-folder retry owned when abandoned spawn and watcher receipts arrive', async () => {
		let release!: (value: { success: boolean }) => void;
		let releaseWatch!: (value: { success: boolean }) => void;
		ipc.autorun.watchFolder.mockReturnValueOnce(new Promise((resolve) => (releaseWatch = resolve)));
		ipc.process.spawn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const onComplete = vi.fn(),
			onError = vi.fn();
		const pending = phaseGenerator.generateDocuments(config, { onComplete, onError });
		await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
		const oldId = ipc.process.spawn.mock.calls[0][0].sessionId;
		phaseGenerator.abort();
		expect(await pending).toMatchObject({
			success: false,
			error: expect.stringContaining('cancelled'),
		});
		const retryComplete = vi.fn(),
			retryChunk = vi.fn();
		const retry = phaseGenerator.generateDocuments(config, {
			onComplete: retryComplete,
			onChunk: retryChunk,
		});
		await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledTimes(2));
		const retryId = ipc.process.spawn.mock.calls[1][0].sessionId;
		expect(retryId).not.toBe(oldId);
		expect(ipc.autorun.onFileChanged).toHaveBeenCalledOnce();
		expect(ipc.autorun.unwatchFolder).toHaveBeenCalledOnce();
		release({ success: true });
		releaseWatch({ success: true });
		await vi.advanceTimersByTimeAsync(0);
		ipc.process.onData.mock.calls[0][0](oldId, 'obsolete');
		ipc.process.onExit.mock.calls[0][0](oldId, 0);
		ipc.process.onAgentError.mock.calls[0][0](oldId, { message: 'obsolete error' });
		expect(onComplete).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		expect(ipc.process.kill.mock.calls).toEqual([[oldId], [oldId]]);
		expect(phaseGenerator.isGenerationInProgress()).toBe(true);
		expect(ipc.autorun.unwatchFolder).toHaveBeenCalledOnce();
		expect(ipc.autorun.onFileChanged).toHaveBeenCalledOnce();
		expect(retryChunk).not.toHaveBeenCalled();
		ipc.process.onData.mock.calls[1][0](retryId, document);
		ipc.process.onExit.mock.calls[1][0](retryId, 0);
		expect(await retry).toMatchObject({ success: true, rawOutput: document });
		expect(retryComplete).toHaveBeenCalledOnce();
		expect(ipc.autorun.unwatchFolder).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		['incomplete', document.replace('---END DOCUMENT---', ''), 'incomplete document'],
		['duplicate', document + '\n' + document, 'duplicate document names'],
		['missing filename', document.replace('FILENAME: Phase-01.md\n', ''), 'without a filename'],
		['missing content', document.replace('CONTENT:', 'BODY:'), 'without content'],
		['unsafe filename', document.replace('Phase-01.md', '../Phase-01.md'), 'invalid or task-free'],
		['wrong extension', document.replace('Phase-01.md', 'Phase-01.txt'), 'invalid or task-free'],
		['task-free', document.replace('- [ ] Build it', 'Nothing actionable'), 'invalid or task-free'],
		['unstructured', '# Phase 1\n## Tasks\n- [ ] Build it', 'complete task documents'],
	] as const)('refuses %s documents through generation', async (_name, output, error) => {
		const onComplete = vi.fn(),
			onError = vi.fn();
		const pending = phaseGenerator.generateDocuments(config, { onComplete, onError });
		await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
		const id = ipc.process.spawn.mock.calls[0][0].sessionId;
		ipc.process.onData.mock.calls[0][0](id, output);
		ipc.process.onExit.mock.calls[0][0](id, 0);
		const result = await pending;
		expect(result).toMatchObject({ success: false, error: expect.stringContaining(error) });
		expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
		expect(onComplete).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])(
		'merges ordered disk/response documents unless conflicting: %s',
		async (conflict) => {
			const content = '# Phase 1: Setup\n## Tasks\n- [ ] Build it';
			ipc.autorun.listDocs.mockResolvedValue({ success: true, files: ['Phase-03', 'Phase-02'] });
			ipc.autorun.readDoc.mockImplementation(async (_folder, name) => ({
				success: true,
				content: name === 'Phase-02' && conflict ? content + '\n- [ ] Conflict' : `\n${content}\n`,
			}));
			const onComplete = vi.fn(),
				onError = vi.fn();
			const pending = phaseGenerator.generateDocuments(config, { onComplete, onError });
			await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
			const id = ipc.process.spawn.mock.calls[0][0].sessionId;
			ipc.process.onData.mock.calls[0][0](
				id,
				document.replace('Phase-01.md', 'Phase-02.md') + '\n' + document
			);
			ipc.process.onExit.mock.calls[0][0](id, 0);
			const result = await pending;
			if (conflict) {
				expect(result).toMatchObject({
					success: false,
					error: expect.stringContaining('conflicting disk and response'),
				});
				expect(onComplete).not.toHaveBeenCalled();
				expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
			} else {
				expect(result).toMatchObject({ success: true, documentsFromDisk: false });
				expect(result.documents?.map(({ filename }) => filename)).toEqual([
					'Phase-01.md',
					'Phase-02.md',
					'Phase-03.md',
				]);
				expect(result.documents?.map(({ taskCount, savedPath }) => [taskCount, savedPath])).toEqual(
					[
						[1, undefined],
						[1, undefined],
						[1, undefined],
					]
				);
				expect(onComplete).toHaveBeenCalledExactlyOnceWith(result);
				expect(onError).not.toHaveBeenCalled();
			}
			expect(ipc.autorun.readDoc.mock.calls).toEqual([
				['/project/.maestro/playbooks', 'Phase-03', undefined],
				['/project/.maestro/playbooks', 'Phase-02', undefined],
			]);
		}
	);

	it.each([
		'list failure',
		'invalid list',
		'list rejection',
		'read failure',
		'empty read',
		'read rejection',
		'task-free disk',
		'unsafe disk',
	] as const)('refuses %s even with a valid response document', async (failure) => {
		ipc.autorun.listDocs.mockResolvedValue({
			success: true,
			files: [failure === 'unsafe disk' ? '../Phase-02' : 'Phase-02'],
		});
		ipc.autorun.readDoc.mockResolvedValue({
			success: true,
			content: '# Phase 2\n## Tasks\n- [ ] Continue',
		});
		if (failure === 'list failure') ipc.autorun.listDocs.mockResolvedValue({ success: false });
		if (failure === 'invalid list') ipc.autorun.listDocs.mockResolvedValue({ success: true });
		if (failure === 'list rejection')
			ipc.autorun.listDocs.mockRejectedValue(new Error('Disk unavailable'));
		if (failure === 'read failure') ipc.autorun.readDoc.mockResolvedValue({ success: false });
		if (failure === 'empty read')
			ipc.autorun.readDoc.mockResolvedValue({ success: true, content: '' });
		if (failure === 'read rejection')
			ipc.autorun.readDoc.mockRejectedValue(new Error('Disk unavailable'));
		if (failure === 'task-free disk')
			ipc.autorun.readDoc.mockResolvedValue({ success: true, content: '# Phase 2\nNo tasks' });
		const onComplete = vi.fn(),
			onError = vi.fn();
		const pending = phaseGenerator.generateDocuments(config, { onComplete, onError });
		await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
		const id = ipc.process.spawn.mock.calls[0][0].sessionId;
		ipc.process.onData.mock.calls[0][0](id, document);
		ipc.process.onExit.mock.calls[0][0](id, 0);
		const result = await pending;
		expect(result).toMatchObject({ success: false, error: expect.any(String) });
		expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('snapshots selected env and host before pending agent lookup', async () => {
		let release!: (value: unknown) => void;
		ipc.agents.get.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
		const selected = {
			...config,
			sessionCustomEnvVars: { GROK_HOME: '/account-a' },
			sshRemoteConfig: { enabled: true, remoteId: 'host-a', workingDirOverride: '/remote-a' },
		};
		const pending = phaseGenerator.generateDocuments(selected);
		selected.sessionCustomEnvVars.GROK_HOME = '/account-b';
		Object.assign(selected.sshRemoteConfig, {
			remoteId: 'host-b',
			workingDirOverride: '/remote-b',
		});
		expect(ipc.process.spawn).not.toHaveBeenCalled();
		release({ id: 'grok', command: 'grok', args: [], available: false });
		await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
		const spawn = ipc.process.spawn.mock.calls[0][0];
		expect(spawn).toMatchObject({
			sessionCustomEnvVars: { GROK_HOME: '/account-a' },
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'host-a',
				workingDirOverride: '/remote-a',
			},
		});
		expect(ipc.autorun.watchFolder).toHaveBeenCalledExactlyOnceWith(
			'/project/.maestro/playbooks',
			'host-a'
		);
		ipc.process.onData.mock.calls[0][0](spawn.sessionId, document);
		ipc.process.onExit.mock.calls[0][0](spawn.sessionId, 0);
		expect(await pending).toMatchObject({ success: true });
		expect(ipc.autorun.listDocs).toHaveBeenCalledExactlyOnceWith(
			'/project/.maestro/playbooks',
			'host-a'
		);
	});

	it.each([undefined, '   '])(
		'refuses missing local binary with custom path %s',
		async (sessionCustomPath) => {
			ipc.agents.get.mockResolvedValue({ id: 'grok', command: 'grok', args: [], available: false });
			const onComplete = vi.fn(),
				onError = vi.fn();
			const result = await phaseGenerator.generateDocuments(
				{ ...config, sessionCustomPath },
				{ onComplete, onError }
			);
			expect(result).toMatchObject({
				success: false,
				error: expect.stringContaining('not available locally'),
			});
			expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
			expect(onComplete).not.toHaveBeenCalled();
			expect(ipc.process.spawn).not.toHaveBeenCalled();
			expect(ipc.autorun.watchFolder).not.toHaveBeenCalled();
		}
	);

	it.each(['preparation', 'execution', 'disk read'] as const)(
		'cancels during %s without clearing a retry',
		async (stage) => {
			let release!: (value: unknown) => void;
			const deferred = new Promise((resolve) => (release = resolve));
			if (stage === 'preparation') ipc.agents.get.mockReturnValueOnce(deferred);
			if (stage === 'disk read') {
				ipc.autorun.listDocs.mockResolvedValueOnce({ success: true, files: ['Phase-01'] });
				ipc.autorun.readDoc.mockReturnValueOnce(deferred);
			}
			const callbacks = {
				onComplete: vi.fn(),
				onError: vi.fn(),
				onChunk: vi.fn(),
				onFileCreated: vi.fn(),
				onActivity: vi.fn(),
			};
			const pending = phaseGenerator.generateDocuments(config, callbacks);
			if (stage !== 'preparation') {
				await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
				if (stage === 'disk read') {
					const id = ipc.process.spawn.mock.calls[0][0].sessionId;
					ipc.process.onData.mock.calls[0][0](id, document);
					ipc.process.onExit.mock.calls[0][0](id, 0);
					await vi.waitFor(() => expect(ipc.autorun.readDoc).toHaveBeenCalledOnce());
				}
			}
			phaseGenerator.abort();
			if (stage !== 'disk read')
				expect(await pending).toMatchObject({
					success: false,
					error: expect.stringContaining('cancelled'),
				});
			Object.values(callbacks).forEach((callback) => callback.mockClear());
			const retry = phaseGenerator.generateDocuments(config);
			await vi.waitFor(() =>
				expect(ipc.process.spawn).toHaveBeenCalledTimes(stage === 'preparation' ? 1 : 2)
			);
			const index = ipc.process.spawn.mock.calls.length - 1;
			const retryId = ipc.process.spawn.mock.calls[index][0].sessionId;
			release(
				stage === 'preparation'
					? { id: 'grok', available: true, command: 'grok', args: [] }
					: { success: true, content: '# Phase 1\n## Tasks\n- [ ] Build it' }
			);
			expect(await pending).toMatchObject({
				success: false,
				error: expect.stringContaining('cancelled'),
			});
			if (stage !== 'preparation') {
				const oldId = ipc.process.spawn.mock.calls[0][0].sessionId;
				ipc.process.onData.mock.calls[0][0](oldId, 'obsolete');
				ipc.process.onExit.mock.calls[0][0](oldId, 0);
				ipc.process.onAgentError.mock.calls[0][0](oldId, { message: 'obsolete' });
				ipc.autorun.onFileChanged.mock.calls[0][0]({
					folderPath: '/project/.maestro/playbooks',
					filename: 'Phase-99',
					eventType: 'change',
				});
				expect(ipc.process.kill.mock.calls).toEqual(stage === 'execution' ? [[oldId]] : []);
			} else expect(ipc.process.kill).not.toHaveBeenCalled();
			Object.values(callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled());
			expect(phaseGenerator.isGenerationInProgress()).toBe(true);
			expect(ipc.process.onData.mock.results[index].value).not.toHaveBeenCalled();
			ipc.process.onData.mock.calls[index][0](retryId, document);
			ipc.process.onExit.mock.calls[index][0](retryId, 0);
			expect(await retry).toMatchObject({ success: true, rawOutput: document });
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each([false, true])(
		'keeps the inactivity deadline after early exit awaiting acceptance: %s',
		async (earlyExit) => {
			let release!: (value: { success: boolean }) => void;
			if (earlyExit)
				ipc.process.spawn.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
			const onComplete = vi.fn(),
				onError = vi.fn(),
				onActivity = vi.fn();
			const pending = phaseGenerator.generateDocuments(config, { onComplete, onError, onActivity });
			await vi.waitFor(() => expect(ipc.process.spawn).toHaveBeenCalledOnce());
			const id = ipc.process.spawn.mock.calls[0][0].sessionId;
			await vi.advanceTimersByTimeAsync(1_199_000);
			ipc.process.onData.mock.calls[0][0](id, document);
			if (earlyExit) ipc.process.onExit.mock.calls[0][0](id, 0);
			await vi.advanceTimersByTimeAsync(1_199_000);
			ipc.autorun.onFileChanged.mock.calls[0][0]({
				folderPath: '/project/.maestro/playbooks',
				eventType: 'change',
			});
			await vi.advanceTimersByTimeAsync(1_199_999);
			expect(onActivity).toHaveBeenCalledTimes(2);
			expect(onComplete).not.toHaveBeenCalled();
			expect(onError).not.toHaveBeenCalled();
			expect(phaseGenerator.isGenerationInProgress()).toBe(true);
			ipc.process.onData.mock.calls[0][0]('unrelated', 'ignored');
			ipc.autorun.onFileChanged.mock.calls[0][0]({ folderPath: '/unrelated', eventType: 'change' });
			await vi.advanceTimersByTimeAsync(1);
			const result = await pending;
			expect(result).toMatchObject({
				success: false,
				error: expect.stringContaining('20 minutes of inactivity'),
			});
			expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
			if (earlyExit) {
				release({ success: true });
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(ipc.process.kill.mock.calls).toEqual(earlyExit ? [[id], [id]] : [[id]]);
			expect(onComplete).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		}
	);
});

describe('phaseGenerator', () => {
	describe('parseGeneratedDocuments', () => {
		it('should parse documents with BEGIN/END markers', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Phase 01: Setup

## Tasks
- [ ] Task 1
- [ ] Task 2
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-02-Implementation.md
CONTENT:
# Phase 02: Implementation

## Tasks
- [ ] Task 3
- [ ] Task 4
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(2);
			expect(docs[0].filename).toBe('Phase-01-Setup.md');
			expect(docs[0].phase).toBe(1);
			expect(docs[1].filename).toBe('Phase-02-Implementation.md');
			expect(docs[1].phase).toBe(2);
		});

		it('should return empty array when no markers present', () => {
			const output = `I've created the following files for your project:
- Phase-01-Setup.md
- Phase-02-Implementation.md
- Phase-03-Testing.md

Let me know if you need any changes!`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(0);
		});

		it('should sort documents by phase number', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-03-Testing.md
CONTENT:
# Phase 03: Testing
## Tasks
- [ ] Test
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Phase 01: Setup
## Tasks
- [ ] Setup
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-02-Build.md
CONTENT:
# Phase 02: Build
## Tasks
- [ ] Build
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(3);
			expect(docs[0].phase).toBe(1);
			expect(docs[1].phase).toBe(2);
			expect(docs[2].phase).toBe(3);
		});
	});

	describe('splitIntoPhases', () => {
		it('should split content with multiple phase headers', () => {
			const content = `
# Phase 1: Initial Setup

Setting up the project foundation.

## Tasks
- [ ] Create project structure
- [ ] Install dependencies

# Phase 2: Core Features

Building the core features.

## Tasks
- [ ] Implement feature A
- [ ] Implement feature B

# Phase 3: Testing

Testing the application.

## Tasks
- [ ] Write unit tests
- [ ] Write integration tests
`;

			const docs = splitIntoPhases(content);

			expect(docs).toHaveLength(3);
			expect(docs[0].phase).toBe(1);
			expect(docs[1].phase).toBe(2);
			expect(docs[2].phase).toBe(3);
		});

		it('should create single document when no phase headers found', () => {
			// This is the case that caused the bug - agent status output without real document content
			const statusOutput = `I've created the following Auto Run documents for your project:

1. Phase-01-Foundation.md - Sets up the project foundation
2. Phase-02-Features.md - Implements core features
3. Phase-03-Testing.md - Adds comprehensive testing

All files have been saved to the .maestro/playbooks folder.`;

			const docs = splitIntoPhases(statusOutput);

			// This SHOULD return a single document (the fallback behavior)
			// But that document won't have valid tasks
			expect(docs).toHaveLength(1);
			expect(docs[0].filename).toBe('Phase-01-Initial-Setup.md');

			// IMPORTANT: This document should have ZERO tasks because it's status text, not real content
			const taskCount = countTasks(docs[0].content);
			expect(taskCount).toBe(0);
		});

		it('should handle ## Phase headers (h2)', () => {
			const content = `
## Phase 1: Setup
- [ ] Task 1

## Phase 2: Build
- [ ] Task 2
`;

			const docs = splitIntoPhases(content);

			expect(docs).toHaveLength(2);
		});
	});

	describe('countTasks', () => {
		it('should count unchecked checkboxes', () => {
			const content = `
# Phase 1

## Tasks
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;

			expect(countTasks(content)).toBe(3);
		});

		it('should count checked checkboxes too', () => {
			const content = `
# Phase 1

## Tasks
- [x] Completed task
- [ ] Pending task
- [X] Also completed
`;

			expect(countTasks(content)).toBe(3);
		});

		it('should return 0 for content without checkboxes', () => {
			const content = `
I've created the following files:
- Phase-01-Setup.md
- Phase-02-Build.md

Let me know if you need changes!
`;

			expect(countTasks(content)).toBe(0);
		});

		it('should handle various checkbox formats', () => {
			const content = `
- [ ] Standard unchecked
- [x] Standard checked lowercase
- [X] Standard checked uppercase
- [ ]Empty after bracket (no space before text) - should still match
-[ ] No space before bracket - also matches (regex is permissive)
`;

			// The regex /^-\s*\[\s*[xX ]?\s*\]/gm is fairly permissive
			// It matches: dash, optional whitespace, bracket, optional whitespace, optional x/X/space, optional whitespace, bracket
			expect(countTasks(content)).toBe(5);
		});
	});

	describe('validateDocuments', () => {
		it('should validate documents with proper structure', () => {
			const docs = [
				{
					filename: 'Phase-01-Setup.md',
					content: `# Phase 1: Setup

## Tasks
- [ ] Task 1
- [ ] Task 2`,
					phase: 1,
				},
			];

			const result = validateDocuments(docs);

			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('should fail validation when no documents provided', () => {
			const result = validateDocuments([]);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('No documents were generated');
		});

		it('should report documents without tasks', () => {
			const docs = [
				{
					filename: 'Phase-01-Setup.md',
					content: `# Phase 1: Setup

## Tasks
Just some text without checkboxes`,
					phase: 1,
				},
			];

			const result = validateDocuments(docs);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes('has no tasks'))).toBe(true);
		});

		it('should fail when no Phase 1 document exists', () => {
			const docs = [
				{
					filename: 'Phase-02-Build.md',
					content: `# Phase 2: Build

## Tasks
- [ ] Task`,
					phase: 2,
				},
			];

			const result = validateDocuments(docs);

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes('No Phase 1'))).toBe(true);
		});
	});

	describe('sanitizeFilename', () => {
		it('should remove path separators', () => {
			expect(sanitizeFilename('../../etc/passwd')).toBe('--etc-passwd');
			expect(sanitizeFilename('foo/bar/baz.md')).toBe('foo-bar-baz.md');
			expect(sanitizeFilename('foo\\bar\\baz.md')).toBe('foo-bar-baz.md');
		});

		it('should remove directory traversal sequences', () => {
			expect(sanitizeFilename('..file.md')).toBe('file.md');
			expect(sanitizeFilename('file..name.md')).toBe('filename.md');
		});

		it('should remove leading dots', () => {
			expect(sanitizeFilename('.hidden')).toBe('hidden');
			expect(sanitizeFilename('...hidden')).toBe('hidden');
		});

		it('should return default when empty', () => {
			expect(sanitizeFilename('')).toBe('document');
			expect(sanitizeFilename('...')).toBe('document');
		});

		it('should preserve valid filenames', () => {
			expect(sanitizeFilename('Phase-01-Setup.md')).toBe('Phase-01-Setup.md');
			expect(sanitizeFilename('my-document.md')).toBe('my-document.md');
		});
	});

	describe('regression: wizard should show all documents', () => {
		/**
		 * REGRESSION TEST
		 *
		 * This test documents the bug where the wizard dropdown only showed ONE document
		 * even though multiple documents were created on disk.
		 *
		 * Root cause: When Claude Code writes files directly to disk (its normal behavior),
		 * the rawOutput doesn't contain document content - just status messages like
		 * "I've created the following files...". The splitIntoPhases function would create
		 * a single document from this status text, and since documents.length > 0, the code
		 * would never call readDocumentsFromDisk() to get the actual files.
		 *
		 * Fix: Check if parsed documents contain valid tasks. If they have zero tasks,
		 * they're likely just status output, so we should still check the disk.
		 */
		it('should recognize status output has no valid tasks', () => {
			// This simulates what Claude Code outputs when writing files directly to disk
			const agentStatusOutput = `I've successfully created your Auto Run documents:

1. **Phase-01-Foundation-Working-Prototype.md** - Sets up project structure and creates initial prototype
2. **Phase-02-Company-Research-Agent.md** - Implements company research capabilities
3. **Phase-03-People-Investors-Agents.md** - Adds investor and people research
4. **Phase-04-Products-Market-Segments.md** - Product and market analysis
5. **Phase-05-Discovery-Auto-Update-System.md** - Automated discovery updates
6. **Phase-06-Graph-Analytics-Polish.md** - Graph visualization and polish

Each document contains detailed tasks with checkboxes. You can review and edit them before running.`;

			// parseGeneratedDocuments should return empty (no markers)
			const parsedDocs = parseGeneratedDocuments(agentStatusOutput);
			expect(parsedDocs).toHaveLength(0);

			// splitIntoPhases will create ONE document from this text (fallback behavior)
			const splitDocs = splitIntoPhases(agentStatusOutput);
			expect(splitDocs).toHaveLength(1);

			// BUT this document should have ZERO tasks - it's status text, not a real document
			const taskCount = countTasks(splitDocs[0].content);
			expect(taskCount).toBe(0);

			// The fix validates: if totalTasksFromParsed === 0, we should still check disk
			// This is the key assertion that would have caught the original bug
			const hasValidTasks = taskCount > 0;
			expect(hasValidTasks).toBe(false);
		});

		it('should recognize real document content has tasks', () => {
			// This is what a REAL Auto Run document looks like
			const realDocumentContent = `# Phase 01: Foundation & Working Prototype

This phase establishes the project foundation and delivers a working prototype.

## Tasks

- [ ] Create directory structure for entity types
- [ ] Set up Markdown templates with YAML frontmatter
- [ ] Configure Claude agent prompts
- [ ] Implement basic research pipeline
- [ ] Create Harvey.md with wiki-links
- [ ] Generate stub files for linked entities`;

			// If this came through (e.g., with markers), it would have tasks
			const taskCount = countTasks(realDocumentContent);
			expect(taskCount).toBe(6);

			// This would be considered valid
			const hasValidTasks = taskCount > 0;
			expect(hasValidTasks).toBe(true);
		});
	});
});
