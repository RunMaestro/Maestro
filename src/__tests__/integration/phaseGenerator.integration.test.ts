/**
 * @file phaseGenerator.integration.test.ts
 * @description Integration coverage for wizard phase document generation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	GeneratedDocument,
	WizardMessage,
} from '../../renderer/components/Wizard/WizardContext';
import {
	AUTO_RUN_FOLDER_NAME,
	countTasks,
	deriveSshRemoteId,
	generateDocumentGenerationPrompt,
	loadPhaseGeneratorPrompts,
	parseGeneratedDocuments,
	phaseGenerator,
	phaseGeneratorUtils,
	sanitizeFilename,
	splitIntoPhases,
	validateDocuments,
	wizardDebugLogger,
	type GenerationConfig,
} from '../../renderer/components/Wizard/services/phaseGenerator';

const loggerMocks = vi.hoisted(() => ({
	debug: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: loggerMocks,
}));

type ProcessDataHandler = (sessionId: string, data: string) => void;
type ProcessExitHandler = (sessionId: string, code: number) => void;
type FileChangedHandler = (data: {
	folderPath: string;
	filename: string;
	eventType: 'rename' | 'change' | string;
}) => void;

const conversationHistory: WizardMessage[] = [
	{ id: 'm1', role: 'user', content: 'Build a docs automation tool.', timestamp: 1 },
	{ id: 'm2', role: 'assistant', content: 'We need phases with safe first steps.', timestamp: 2 },
];

function createConfig(overrides: Partial<GenerationConfig> = {}): GenerationConfig {
	return {
		agentType: 'claude-code',
		directoryPath: '/repo/project',
		projectName: 'DocsBot',
		conversationHistory,
		...overrides,
	};
}

function createAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		path: '/usr/local/bin/claude',
		args: ['--print'],
		available: true,
		...overrides,
	};
}

function markedDocumentOutput(): string {
	return JSON.stringify({
		type: 'result',
		result: [
			'---BEGIN DOCUMENT---',
			'FILENAME: Phase-02-Polish.md',
			'CONTENT:',
			'# Phase 2: Polish',
			'',
			'## Tasks',
			'- [ ] Add screenshots',
			'---END DOCUMENT---',
			'---BEGIN DOCUMENT---',
			'FILENAME: Phase-01-Prototype.md',
			'CONTENT:',
			'# Phase 1: Prototype',
			'',
			'Create the smallest useful workflow.',
			'',
			'## Tasks',
			'- [ ] Build the prototype',
			'- [x] Keep scope small',
			'---END DOCUMENT---',
		].join('\n'),
	});
}

function phasePromptTemplate(): string {
	return [
		'Project: {{PROJECT_NAME}}',
		'Directory: {{DIRECTORY_PATH}}',
		'Auto Run: {{AUTO_RUN_FOLDER_NAME}}',
		'Conversation:',
		'{{CONVERSATION_SUMMARY}}',
	].join('\n');
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('phaseGenerator integration', () => {
	let dataHandler: ProcessDataHandler | undefined;
	let exitHandler: ProcessExitHandler | undefined;
	let fileChangedHandler: FileChangedHandler | undefined;
	let dataCleanup: ReturnType<typeof vi.fn>;
	let exitCleanup: ReturnType<typeof vi.fn>;
	let fileCleanup: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		dataCleanup = vi.fn();
		exitCleanup = vi.fn();
		fileCleanup = vi.fn();
		dataHandler = undefined;
		exitHandler = undefined;
		fileChangedHandler = undefined;

		(window.maestro.process as any).onData = vi.fn((handler: ProcessDataHandler) => {
			dataHandler = handler;
			return dataCleanup;
		});
		window.maestro.process.onExit = vi.fn((handler: ProcessExitHandler) => {
			exitHandler = handler;
			return exitCleanup;
		});
		window.maestro.process.kill = vi.fn().mockResolvedValue(undefined);
		window.maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 1234 });

		window.maestro.agents.get = vi.fn().mockResolvedValue(createAgent());
		window.maestro.autorun.watchFolder = vi.fn().mockResolvedValue({ success: true });
		window.maestro.autorun.unwatchFolder = vi.fn().mockResolvedValue(undefined);
		(window.maestro.autorun as any).onFileChanged = vi.fn((handler: FileChangedHandler) => {
			fileChangedHandler = handler;
			return fileCleanup;
		});
		window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({ success: true, files: [] });
		window.maestro.autorun.readDoc = vi.fn().mockResolvedValue({ success: true, content: '' });
		window.maestro.autorun.writeDoc = vi.fn().mockResolvedValue({ success: true });
		window.maestro.fs.readFile = vi.fn().mockResolvedValue('');
		(window.maestro.prompts.get as any).mockResolvedValue({
			success: true,
			content: phasePromptTemplate(),
		});
		await loadPhaseGeneratorPrompts(true);

		wizardDebugLogger.clear();
		phaseGenerator.abort();
	});

	afterEach(() => {
		phaseGenerator.abort();
		wizardDebugLogger.clear();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('parses and validates generated document utility contracts', () => {
		const prompt = generateDocumentGenerationPrompt(createConfig({ subfolder: 'Initiation' }));
		expect(prompt).toContain('DocsBot');
		expect(prompt).toContain('/repo/project');
		expect(prompt).toContain(`${AUTO_RUN_FOLDER_NAME}/Initiation`);
		expect(prompt).toContain('User: Build a docs automation tool.');

		const parsed = parseGeneratedDocuments(
			[
				'---BEGIN DOCUMENT---',
				'FILENAME: Phase-03-Finish.md',
				'CONTENT:',
				'# Phase 3: Finish',
				'',
				'## Tasks',
				'- [ ] Ship',
				'---END DOCUMENT---',
				'---BEGIN DOCUMENT---',
				'FILENAME: Phase-01-Start.md',
				'CONTENT:',
				'# Phase 1: Start',
				'',
				'## Tasks',
				'- [ ] Build',
				'---END DOCUMENT---',
			].join('\n')
		);
		expect(parsed.map((doc) => doc.filename)).toEqual(['Phase-01-Start.md', 'Phase-03-Finish.md']);
		expect(countTasks('- [ ] A\n- [x] B\n- [X] C\n* no')).toBe(3);
		expect(validateDocuments(parsed)).toEqual({ valid: true, errors: [] });
		expect(validateDocuments([]).errors).toContain('No documents were generated');
		expect(
			validateDocuments([{ filename: 'notes.md', content: 'No tasks', phase: 0 }]).errors
		).toEqual(
			expect.arrayContaining([
				'notes.md has no tasks (checkbox items)',
				'notes.md is missing a phase header',
				'notes.md is missing a Tasks section',
				'No Phase 1 document was generated',
			])
		);

		expect(
			splitIntoPhases('# Phase 1: Setup!\n## Tasks\n- [ ] One\n\n## Phase 2 - Polish\n- [ ] Two')
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ filename: 'Phase-01-Setup.md', phase: 1 }),
				expect.objectContaining({ filename: 'Phase-02-Polish.md', phase: 2 }),
			])
		);
		expect(splitIntoPhases('## Tasks\n- [ ] Single file')).toEqual([
			expect.objectContaining({ filename: 'Phase-01-Initial-Setup.md', phase: 1 }),
		]);
		expect(sanitizeFilename('../\u0000.hidden/Phase 1.md')).toBe('-.hidden-Phase 1.md');
		expect(deriveSshRemoteId({ enabled: true, remoteId: 'remote-1' })).toBe('remote-1');
		expect(deriveSshRemoteId({ enabled: false, remoteId: 'remote-1' })).toBeUndefined();
		expect(phaseGeneratorUtils.AUTO_RUN_FOLDER_NAME).toBe(AUTO_RUN_FOLDER_NAME);
	});

	it('covers wizard utility edge contracts and debug log export behavior', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-27T08:00:00.000Z'));

		const fallbackPrompt = generateDocumentGenerationPrompt(
			createConfig({
				projectName: '',
				conversationHistory: [
					...conversationHistory,
					{
						id: 'm3',
						role: 'system',
						content: 'System-only context should not enter the summary.',
						timestamp: 3,
					},
				],
			})
		);
		expect(fallbackPrompt).toContain('this project');
		expect(fallbackPrompt).toContain(AUTO_RUN_FOLDER_NAME);
		expect(fallbackPrompt).not.toContain('System-only context');

		const parsedWithoutPhase = parseGeneratedDocuments(
			[
				'---BEGIN DOCUMENT---',
				'FILENAME: Notes.md',
				'CONTENT:',
				'# Notes',
				'',
				'## Tasks',
				'- [ ] Capture notes',
				'---END DOCUMENT---',
				'---BEGIN DOCUMENT---',
				'FILENAME: Empty.md',
				'CONTENT:',
				'---END DOCUMENT---',
			].join('\n')
		);
		expect(parsedWithoutPhase).toEqual([
			expect.objectContaining({ filename: 'Notes.md', phase: 0 }),
		]);
		expect(countTasks('No checkbox tasks here')).toBe(0);
		expect(
			validateDocuments([
				{
					filename: 'Phase-02-Later.md',
					content: '# Phase 2: Later\n\n## Tasks\n- [ ] Later',
					phase: 2,
				},
			])
		).toEqual({ valid: false, errors: ['No Phase 1 document was generated'] });
		expect(splitIntoPhases('# Phase 1\n## Tasks\n- [ ] Start')).toEqual([
			expect.objectContaining({ filename: 'Phase-01-Tasks.md', phase: 1 }),
		]);
		expect(splitIntoPhases('   ')).toEqual([]);
		expect(deriveSshRemoteId()).toBeUndefined();
		expect(deriveSshRemoteId({ enabled: true, remoteId: null })).toBeUndefined();

		wizardDebugLogger.startSession(createConfig());
		for (let index = 0; index < 10001; index++) {
			wizardDebugLogger.log(
				index % 2 === 0 ? 'data' : 'error',
				index % 2 === 0 ? `chunk ${index}` : `error ${index}`
			);
		}

		const exported = wizardDebugLogger.exportLogs();
		expect(exported.logs.length).toBeLessThan(10001);
		expect(exported.summary).toEqual(
			expect.objectContaining({
				totalLogs: exported.logs.length,
				dataChunksReceived: exported.logs.filter((entry) => entry.type === 'data').length,
				errors: exported.logs
					.filter((entry) => entry.type === 'error')
					.map((entry) => entry.message),
			})
		);
		expect(exported.summary.logsByType).toMatchObject({
			data: expect.any(Number),
			error: expect.any(Number),
		});
		expect(exported.sessionInfo).toEqual(
			expect.objectContaining({
				agentType: 'claude-code',
				startTime: new Date('2026-05-27T08:00:00.000Z').getTime(),
				exportTime: new Date('2026-05-27T08:00:00.000Z').getTime(),
				userAgent: expect.any(String),
				platform: expect.any(String),
			})
		);

		const returnedLogs = wizardDebugLogger.getLogs();
		returnedLogs.pop();
		expect(wizardDebugLogger.getLogs()).toHaveLength(exported.logs.length);
	});

	it('downloads debug logs and reports successful save metadata', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-27T08:15:00.000Z'));

		wizardDebugLogger.startSession(createConfig());
		wizardDebugLogger.log('file', 'created Phase-01-Metadata.md');

		const originalCreateElement = document.createElement.bind(document);
		const click = vi.fn();
		vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
			const element = originalCreateElement(tagName, options);
			if (tagName === 'a') {
				Object.defineProperty(element, 'click', {
					configurable: true,
					value: click,
				});
			}
			return element;
		});

		const hadCreateObjectURL = 'createObjectURL' in URL;
		const hadRevokeObjectURL = 'revokeObjectURL' in URL;
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		const createObjectURL = vi.fn().mockReturnValue('blob:wizard-debug');
		const revokeObjectURL = vi.fn();
		Object.defineProperty(URL, 'createObjectURL', {
			configurable: true,
			value: createObjectURL,
		});
		Object.defineProperty(URL, 'revokeObjectURL', {
			configurable: true,
			value: revokeObjectURL,
		});

		try {
			wizardDebugLogger.downloadLogs();
		} finally {
			if (hadCreateObjectURL) {
				Object.defineProperty(URL, 'createObjectURL', {
					configurable: true,
					value: originalCreateObjectURL,
				});
			} else {
				delete (URL as unknown as Record<string, unknown>).createObjectURL;
			}
			if (hadRevokeObjectURL) {
				Object.defineProperty(URL, 'revokeObjectURL', {
					configurable: true,
					value: originalRevokeObjectURL,
				});
			} else {
				delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
			}
		}

		expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
		expect(click).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:wizard-debug');

		const longDescription = `${'Detailed implementation planning '.repeat(8)}final sentence.`;
		const docs: GeneratedDocument[] = [
			{
				filename: 'Phase-01-Metadata',
				content: `# Phase 1: Metadata\n\n${longDescription}\n- [ ] Preserve metadata`,
				taskCount: 1,
			},
		];
		const onFileCreated = vi.fn();

		const saveResult = await phaseGenerator.saveDocuments('/repo/project', docs, onFileCreated);

		expect(saveResult).toEqual({
			success: true,
			savedPaths: [`/repo/project/${AUTO_RUN_FOLDER_NAME}/Phase-01-Metadata.md`],
			subfolderPath: undefined,
		});
		expect(onFileCreated).toHaveBeenCalledWith(
			expect.objectContaining({
				filename: 'Phase-01-Metadata.md',
				description: expect.stringMatching(/\.\.\.$/),
				taskCount: 1,
				timestamp: new Date('2026-05-27T08:15:00.000Z').getTime(),
			})
		);
		expect(onFileCreated.mock.calls[0][0].description).toHaveLength(150);
		expect(docs[0].savedPath).toBe(`/repo/project/${AUTO_RUN_FOLDER_NAME}/Phase-01-Metadata.md`);
	});

	it('generates documents from stream-json agent output and cleans listeners', async () => {
		const callbacks = {
			onStart: vi.fn(),
			onProgress: vi.fn(),
			onChunk: vi.fn(),
			onComplete: vi.fn(),
			onActivity: vi.fn(),
		};
		window.maestro.process.spawn = vi.fn().mockImplementation(async ({ sessionId }) => {
			setTimeout(() => {
				dataHandler?.(sessionId, markedDocumentOutput());
				exitHandler?.(sessionId, 0);
			}, 0);
			return { pid: 2345 };
		});

		const result = await phaseGenerator.generateDocuments(createConfig(), callbacks);

		expect(result.success).toBe(true);
		expect(result.documents?.map((doc) => doc.filename)).toEqual([
			'Phase-01-Prototype.md',
			'Phase-02-Polish.md',
		]);
		expect(result.documents?.[0].taskCount).toBe(2);
		expect(callbacks.onStart).toHaveBeenCalledOnce();
		expect(callbacks.onChunk).toHaveBeenCalledWith(markedDocumentOutput());
		expect(callbacks.onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				toolType: 'claude-code',
				cwd: '/repo/project',
				command: '/usr/local/bin/claude',
				args: expect.arrayContaining([
					'--print',
					'--include-partial-messages',
					'--allowedTools',
					'Write',
				]),
			})
		);
		expect(window.maestro.autorun.watchFolder).toHaveBeenCalledWith(
			`/repo/project/${AUTO_RUN_FOLDER_NAME}`,
			undefined
		);
		expect(dataCleanup).toHaveBeenCalledOnce();
		expect(exitCleanup).toHaveBeenCalledOnce();
		expect(window.maestro.autorun.unwatchFolder).toHaveBeenCalledWith(
			`/repo/project/${AUTO_RUN_FOLDER_NAME}`
		);
	});

	it('falls back to remote disk documents when agent output has no tasks', async () => {
		window.maestro.agents.get = vi.fn().mockResolvedValue(createAgent({ available: false }));
		window.maestro.process.spawn = vi.fn().mockImplementation(async ({ sessionId }) => {
			setTimeout(() => {
				dataHandler?.(sessionId, 'Created the files on disk.');
				exitHandler?.(sessionId, 0);
			}, 0);
			return { pid: 3456 };
		});
		window.maestro.autorun.listDocs = vi
			.fn()
			.mockResolvedValue({ success: true, files: ['Phase-02-Deploy', 'Phase-01-Build.md'] });
		window.maestro.autorun.readDoc = vi.fn().mockImplementation(async (_folder, filename) => ({
			success: true,
			content:
				filename === 'Phase-02-Deploy'
					? '# Phase 2: Deploy\n\n## Tasks\n- [ ] Deploy'
					: '# Phase 1: Build\n\n## Tasks\n- [ ] Build',
		}));

		const result = await phaseGenerator.generateDocuments(
			createConfig({
				subfolder: 'Initiation',
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			})
		);

		expect(result.success).toBe(true);
		expect(result.documentsFromDisk).toBe(true);
		expect(result.documents?.map((doc) => doc.filename)).toEqual([
			'Phase-01-Build.md',
			'Phase-02-Deploy.md',
		]);
		expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith(
			`/repo/project/${AUTO_RUN_FOLDER_NAME}/Initiation`,
			'remote-1'
		);
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			})
		);
	});

	it('handles invalid parsed output and empty disk fallback validation', async () => {
		const callbacks = {
			onProgress: vi.fn(),
			onError: vi.fn(),
		};
		window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({ success: true, files: [] });
		window.maestro.process.spawn = vi.fn().mockImplementation(async ({ sessionId }) => {
			setTimeout(() => {
				dataHandler?.(sessionId, 'Agent wrote files directly without returning task markdown.');
				exitHandler?.(sessionId, 0);
			}, 0);
			return { pid: 6789 };
		});

		const salvaged = await phaseGenerator.generateDocuments(createConfig(), callbacks);

		expect(salvaged.success).toBe(true);
		expect(salvaged.documents).toEqual([
			expect.objectContaining({
				filename: 'Phase-01-Initial-Setup.md',
				taskCount: 0,
			}),
		]);
		expect(callbacks.onProgress).toHaveBeenCalledWith(
			expect.stringContaining('validation warning(s), proceeding anyway')
		);
		expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith(
			`/repo/project/${AUTO_RUN_FOLDER_NAME}`,
			undefined
		);

		callbacks.onProgress.mockClear();
		callbacks.onError.mockClear();
		window.maestro.process.spawn = vi.fn().mockImplementation(async ({ sessionId }) => {
			setTimeout(() => {
				exitHandler?.(sessionId, 0);
			}, 0);
			return { pid: 6790 };
		});
		window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({ success: false });

		const failed = await phaseGenerator.generateDocuments(createConfig(), callbacks);

		expect(failed).toEqual(
			expect.objectContaining({
				success: false,
				error: 'Document validation failed: No documents were generated',
			})
		);
		expect(callbacks.onError).toHaveBeenCalledWith(
			'Document validation failed: No documents were generated'
		);
	});

	it('reports unavailable agents, spawn failures, and concurrent generation attempts', async () => {
		const onError = vi.fn();
		window.maestro.agents.get = vi.fn().mockResolvedValue(null);

		await expect(phaseGenerator.generateDocuments(createConfig(), { onError })).resolves.toEqual(
			expect.objectContaining({
				success: false,
				error: 'Agent claude-code configuration not found',
			})
		);
		expect(onError).toHaveBeenCalledWith('Agent claude-code configuration not found');

		window.maestro.agents.get = vi.fn().mockResolvedValue(createAgent({ available: false }));
		const missingFromPath = await phaseGenerator.generateDocuments(createConfig());
		expect(missingFromPath.success).toBe(false);
		expect(missingFromPath.error).toContain('The agent was not found in your system PATH.');

		window.maestro.agents.get = vi.fn().mockResolvedValue(
			createAgent({
				available: false,
				customPath: '/missing/claude',
			})
		);
		const unavailable = await phaseGenerator.generateDocuments(createConfig());
		expect(unavailable.success).toBe(false);
		expect(unavailable.error).toContain('custom path "/missing/claude" is not valid');

		window.maestro.agents.get = vi.fn().mockResolvedValue(createAgent());
		window.maestro.process.spawn = vi.fn().mockRejectedValue(new Error('spawn denied'));
		const spawnFailure = await phaseGenerator.generateDocuments(createConfig());
		expect(spawnFailure).toEqual({
			success: false,
			error: 'Failed to spawn agent: spawn denied',
		});

		window.maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 4567 });
		const first = phaseGenerator.generateDocuments(createConfig());
		await Promise.resolve();
		const second = await phaseGenerator.generateDocuments(createConfig());
		expect(second).toEqual({ success: false, error: 'Generation already in progress' });
		const firstSessionId = vi.mocked(window.maestro.process.spawn).mock.calls.at(-1)?.[0].sessionId;
		expect(firstSessionId).toBeTruthy();
		exitHandler?.(firstSessionId!, 1);
		await expect(first).resolves.toEqual(
			expect.objectContaining({ success: false, error: 'Agent exited with code 1' })
		);
	});

	it('reports file watcher activity and saves sanitized documents through Auto Run IPC', async () => {
		const onFileCreated = vi.fn();
		window.maestro.fs.readFile = vi
			.fn()
			.mockRejectedValueOnce(new Error('still writing'))
			.mockResolvedValueOnce('# Phase 1: File\n\nFirst useful paragraph.\n\n## Tasks\n- [ ] Read');
		window.maestro.process.spawn = vi.fn().mockImplementation(async ({ sessionId }) => {
			setTimeout(() => {
				fileChangedHandler?.({
					folderPath: `/repo/project/${AUTO_RUN_FOLDER_NAME}`,
					filename: 'Phase-01-File',
					eventType: 'rename',
				});
				dataHandler?.(sessionId, markedDocumentOutput());
				exitHandler?.(sessionId, 0);
			}, 0);
			return { pid: 5678 };
		});

		const result = await phaseGenerator.generateDocuments(createConfig(), { onFileCreated });

		expect(result.success).toBe(true);
		await vi.waitFor(() =>
			expect(onFileCreated).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'Phase-01-File.md',
					description: 'First useful paragraph.',
					taskCount: 1,
				})
			)
		);

		const docs: GeneratedDocument[] = [
			{
				filename: '../Phase-01-Setup',
				content: '# Phase 1: Setup\n\nDescription text.\n\n## Tasks\n- [ ] Do it',
				taskCount: 1,
			},
			{
				filename: 'Phase-02-Fail.md',
				content: '# Phase 2: Fail\n\n## Tasks\n- [ ] Fail',
				taskCount: 1,
			},
		];
		window.maestro.autorun.writeDoc = vi
			.fn()
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: false, error: 'disk full' });

		const saveResult = await phaseGenerator.saveDocuments(
			'/repo/project',
			docs,
			onFileCreated,
			'Initiation',
			'remote-1'
		);

		expect(window.maestro.autorun.writeDoc).toHaveBeenNthCalledWith(
			1,
			`/repo/project/${AUTO_RUN_FOLDER_NAME}/Initiation`,
			'-Phase-01-Setup.md',
			docs[0].content,
			'remote-1'
		);
		expect(saveResult).toEqual({
			success: false,
			savedPaths: [`/repo/project/${AUTO_RUN_FOLDER_NAME}/Initiation/-Phase-01-Setup.md`],
			error: 'disk full',
		});
		expect(docs[0].savedPath).toBe(
			`/repo/project/${AUTO_RUN_FOLDER_NAME}/Initiation/-Phase-01-Setup.md`
		);
		expect(phaseGenerator.getAutoRunPath('/repo/project')).toBe(
			`/repo/project/${AUTO_RUN_FOLDER_NAME}`
		);
		expect(phaseGenerator.isGenerationInProgress()).toBe(false);
	});

	it('times out inactive generation and swallows rejected cleanup promises', async () => {
		vi.useFakeTimers();
		window.maestro.process.kill = vi.fn().mockRejectedValue(new Error('already stopped'));
		window.maestro.autorun.unwatchFolder = vi.fn().mockRejectedValue(new Error('unwatch failed'));

		const resultPromise = phaseGenerator.generateDocuments(createConfig());
		await flushPromises();
		const spawnCall = vi.mocked(window.maestro.process.spawn).mock.calls.at(-1)?.[0];
		expect(spawnCall?.sessionId).toBeTruthy();
		expect(window.maestro.autorun.onFileChanged).toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1_200_000);
		await flushPromises();

		await expect(resultPromise).resolves.toEqual({
			success: false,
			error: 'Generation timed out after 20 minutes of inactivity. Please try again.',
			rawOutput: '',
		});
		expect(window.maestro.process.kill).toHaveBeenCalledWith(spawnCall?.sessionId);
		expect(dataCleanup).toHaveBeenCalledOnce();
		expect(exitCleanup).toHaveBeenCalledOnce();
		expect(fileCleanup).toHaveBeenCalledOnce();
		expect(window.maestro.autorun.unwatchFolder).toHaveBeenCalledWith(
			`/repo/project/${AUTO_RUN_FOLDER_NAME}`
		);
	});

	it('logs progress every tenth data chunk', async () => {
		const resultPromise = phaseGenerator.generateDocuments(createConfig());
		await flushPromises();
		const spawnCall = vi.mocked(window.maestro.process.spawn).mock.calls.at(-1)?.[0];
		expect(spawnCall?.sessionId).toBeTruthy();

		loggerMocks.info.mockClear();
		for (let index = 0; index < 9; index++) {
			dataHandler?.(spawnCall!.sessionId, `chunk-${index}\n`);
		}
		expect(loggerMocks.info).not.toHaveBeenCalledWith(
			'[PhaseGenerator] Progress:',
			undefined,
			expect.anything()
		);

		dataHandler?.(spawnCall!.sessionId, 'chunk-9\n');
		expect(loggerMocks.info).toHaveBeenCalledWith(
			'[PhaseGenerator] Progress:',
			undefined,
			expect.objectContaining({ chunks: 10 })
		);

		dataHandler?.(spawnCall!.sessionId, markedDocumentOutput());
		exitHandler?.(spawnCall!.sessionId, 0);
		await expect(resultPromise).resolves.toMatchObject({ success: true });
	});

	it('continues when folder watching is unavailable or setup rejects', async () => {
		window.maestro.autorun.watchFolder = vi
			.fn()
			.mockResolvedValueOnce({ success: false, error: 'permission denied' })
			.mockRejectedValueOnce(new Error('watch failed'));

		const unavailableWatch = phaseGenerator.generateDocuments(createConfig());
		await flushPromises();
		const unavailableSpawn = vi.mocked(window.maestro.process.spawn).mock.calls.at(-1)?.[0];
		expect(loggerMocks.warn).toHaveBeenCalledWith(
			'[PhaseGenerator] Could not watch folder:',
			undefined,
			'permission denied'
		);
		dataHandler?.(unavailableSpawn!.sessionId, markedDocumentOutput());
		exitHandler?.(unavailableSpawn!.sessionId, 0);
		await expect(unavailableWatch).resolves.toMatchObject({ success: true });

		loggerMocks.warn.mockClear();
		const rejectedWatch = phaseGenerator.generateDocuments(createConfig());
		await flushPromises();
		const rejectedSpawn = vi.mocked(window.maestro.process.spawn).mock.calls.at(-1)?.[0];
		expect(loggerMocks.warn).toHaveBeenCalledWith(
			'[PhaseGenerator] Error setting up folder watcher:',
			undefined,
			expect.any(Error)
		);
		dataHandler?.(rejectedSpawn!.sessionId, markedDocumentOutput());
		exitHandler?.(rejectedSpawn!.sessionId, 0);
		await expect(rejectedWatch).resolves.toMatchObject({ success: true });
	});

	it('falls back to parsed status output when disk document reads throw', async () => {
		window.maestro.autorun.listDocs = vi.fn().mockRejectedValue(new Error('remote list failed'));

		const resultPromise = phaseGenerator.generateDocuments(createConfig());
		await flushPromises();
		const spawnCall = vi.mocked(window.maestro.process.spawn).mock.calls.at(-1)?.[0];
		expect(spawnCall?.sessionId).toBeTruthy();

		dataHandler?.(spawnCall!.sessionId, 'Created files in Auto Run Docs.');
		exitHandler?.(spawnCall!.sessionId, 0);

		const result = await resultPromise;
		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				documentsFromDisk: false,
			})
		);
		expect(result.documents?.[0]).toEqual(
			expect.objectContaining({
				filename: 'Phase-01-Initial-Setup.md',
				taskCount: 0,
			})
		);
		expect(loggerMocks.error).toHaveBeenCalledWith(
			'[PhaseGenerator] Error reading documents from disk:',
			undefined,
			expect.any(Error)
		);
	});
});
