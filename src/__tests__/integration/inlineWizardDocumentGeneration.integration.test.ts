import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	countTasks,
	extractDisplayTextFromChunk,
	generateDocumentPrompt,
	generateInlineDocuments,
	generateWizardFolderBaseName,
	loadInlineWizardDocGenPrompts,
	parseGeneratedDocuments,
	sanitizeFilename,
	splitIntoPhases,
	type DocumentGenerationConfig,
} from '../../renderer/services/inlineWizardDocumentGeneration';

type MockMaestro = {
	agents: { get: ReturnType<typeof vi.fn> };
	process: {
		spawn: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		onData: ReturnType<typeof vi.fn>;
		onExit: ReturnType<typeof vi.fn>;
	};
	autorun: {
		listDocs: ReturnType<typeof vi.fn>;
		writeDoc: ReturnType<typeof vi.fn>;
		readDoc: ReturnType<typeof vi.fn>;
		watchFolder: ReturnType<typeof vi.fn>;
		unwatchFolder: ReturnType<typeof vi.fn>;
		onFileChanged: ReturnType<typeof vi.fn>;
	};
	fs: { readFile: ReturnType<typeof vi.fn> };
	playbooks: { create: ReturnType<typeof vi.fn> };
	prompts: { get: ReturnType<typeof vi.fn> };
	logger: { log: ReturnType<typeof vi.fn> };
};

describe('inline wizard document generation integration', () => {
	let maestro: MockMaestro;
	let originalMaestro: typeof window.maestro;
	let capturedDataCallback: ((sessionId: string, data: string) => void) | undefined;
	let capturedExitCallback: ((sessionId: string, code: number) => void) | undefined;
	let capturedFileChangedCallback:
		((data: { folderPath: string; filename?: string; eventType: string }) => void) | undefined;
	let consoleError: ReturnType<typeof vi.spyOn>;
	let consoleLog: ReturnType<typeof vi.spyOn>;
	let consoleWarn: ReturnType<typeof vi.spyOn>;

	const createConfig = (
		overrides: Partial<DocumentGenerationConfig> = {}
	): DocumentGenerationConfig => ({
		agentType: 'opencode',
		directoryPath: '/repo',
		projectName: 'Coverage Project',
		conversationHistory: [
			{ id: 'user-1', role: 'user', content: 'Build phases', timestamp: 1 },
			{ id: 'assistant-1', role: 'assistant', content: 'Use two phases', timestamp: 2 },
			{ id: 'system-1', role: 'system', content: 'Ignored in prompts', timestamp: 3 },
		],
		mode: 'new',
		autoRunFolderPath: '/repo/Auto Run Docs',
		...overrides,
	});

	const promptFilenameMap: Record<string, string> = {
		'wizard-document-generation': 'wizard-document-generation.md',
		'wizard-inline-iterate-generation': 'wizard-inline-iterate-generation.md',
	};

	function readPrompt(id: string) {
		const filename = promptFilenameMap[id];
		if (!filename) {
			return Promise.resolve({ success: false, error: `Unknown prompt: ${id}` });
		}

		try {
			const content = fs.readFileSync(path.resolve(process.cwd(), 'src/prompts', filename), 'utf8');
			return Promise.resolve({ success: true, content });
		} catch (error) {
			return Promise.resolve({
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function installMaestro() {
		capturedDataCallback = undefined;
		capturedExitCallback = undefined;
		capturedFileChangedCallback = undefined;
		maestro = {
			agents: {
				get: vi.fn().mockResolvedValue({
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: ['--verbose'],
				}),
			},
			process: {
				spawn: vi.fn(),
				kill: vi.fn().mockResolvedValue(undefined),
				onData: vi.fn((callback) => {
					capturedDataCallback = callback;
					return vi.fn();
				}),
				onExit: vi.fn((callback) => {
					capturedExitCallback = callback;
					return vi.fn();
				}),
			},
			autorun: {
				listDocs: vi.fn().mockResolvedValue({ success: true, tree: [] }),
				writeDoc: vi.fn().mockResolvedValue({ success: true }),
				readDoc: vi.fn().mockResolvedValue({ success: false }),
				watchFolder: vi.fn().mockResolvedValue({ success: true }),
				unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
				onFileChanged: vi.fn((callback) => {
					capturedFileChangedCallback = callback;
					return vi.fn();
				}),
			},
			fs: {
				readFile: vi.fn().mockResolvedValue(''),
			},
			playbooks: {
				create: vi.fn().mockResolvedValue({
					success: true,
					playbook: { id: 'playbook-1', name: 'Coverage Project' },
				}),
			},
			prompts: {
				get: vi.fn(readPrompt),
			},
			logger: {
				log: vi.fn((level: string, message: string, _context?: string, data?: unknown) => {
					const target =
						level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
					if (data === undefined) {
						target(message);
					} else if (Array.isArray(data)) {
						target(message, ...data);
					} else {
						target(message, data);
					}
				}),
			},
		};
		(window as any).maestro = maestro;
	}

	function completeSpawnWithOutput(output: string, exitCode = 0) {
		maestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
			setTimeout(() => capturedDataCallback?.(sessionId, output), 0);
			setTimeout(() => capturedExitCallback?.(sessionId, exitCode), 5);
		});
	}

	beforeEach(async () => {
		originalMaestro = window.maestro;
		installMaestro();
		await loadInlineWizardDocGenPrompts(true);
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		(window as any).maestro = originalMaestro;
	});

	it('formats stream chunks, prompts, filenames, tasks, and parsed phase documents', () => {
		const claudeChunk = [
			JSON.stringify({ type: 'content_block_delta', delta: { text: 'Hello ' } }),
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'text', text: 'world' }, { type: 'tool_use' }] },
			}),
			'not-json',
		].join('\n');
		const opencodeChunk = JSON.stringify({ type: 'text', part: { text: 'OpenCode' } });
		const codexChunk = [
			JSON.stringify({ type: 'agent_message', content: [{ type: 'text', text: 'Codex ' }] }),
			JSON.stringify({ type: 'message', text: 'done' }),
		].join('\n');

		expect(extractDisplayTextFromChunk(claudeChunk, 'claude-code')).toBe('Hello world');
		expect(extractDisplayTextFromChunk(opencodeChunk, 'opencode')).toBe('OpenCode');
		expect(extractDisplayTextFromChunk(codexChunk, 'codex')).toBe('Codex done');
		expect(extractDisplayTextFromChunk('bad json', 'gemini-cli')).toBe('');
		expect(sanitizeFilename('Phase/01\u0000.md')).toBe('Phase-01.md');
		expect(sanitizeFilename('../')).toBe('-');
		expect(countTasks('- [ ] One\n- [x] Two\nplain')).toBe(2);
		expect(generateWizardFolderBaseName('Ship docs!')).toMatch(/^\d{4}-\d{2}-\d{2}-Ship-Docs$/);

		const docs = parseGeneratedDocuments(`
---BEGIN DOCUMENT---
FILENAME: Phase-02-Build.md
CONTENT:
# Build
- [ ] Build
---END DOCUMENT---
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
UPDATE: true
CONTENT:
# Setup
- [ ] Setup
---END DOCUMENT---
`);
		expect(docs.map((doc) => [doc.filename, doc.phase, doc.isUpdate])).toEqual([
			['Phase-01-Setup.md', 1, true],
			['Phase-02-Build.md', 2, false],
		]);
		expect(splitIntoPhases('# Phase 1: Setup\n- [ ] A\n## Phase 2 - Build\n- [ ] B')).toHaveLength(
			2
		);

		const prompt = generateDocumentPrompt(
			createConfig({
				mode: 'iterate',
				goal: 'Add polish',
				existingDocuments: [{ filename: 'Phase-01.md', content: '# Existing' }],
			}),
			'Subfolder'
		);
		expect(prompt).toContain('Coverage Project');
		expect(prompt).toContain('/repo/Auto Run Docs/Subfolder');
		expect(prompt).toContain('# Existing');
		expect(prompt).toContain('Add polish');
		expect(prompt).not.toContain('Ignored in prompts');
	});

	it('spawns a local agent, saves parsed stream documents, emits callbacks, and creates a playbook', async () => {
		completeSpawnWithOutput(
			JSON.stringify({
				type: 'text',
				part: {
					text: `
---BEGIN DOCUMENT---
FILENAME: Phase-02-Build.md
CONTENT:
# Build
- [ ] Build task
---END DOCUMENT---
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Setup
- [ ] Setup task
---END DOCUMENT---
`,
				},
			})
		);
		const callbacks = {
			onStart: vi.fn(),
			onProgress: vi.fn(),
			onChunk: vi.fn(),
			onDocumentComplete: vi.fn(),
			onComplete: vi.fn(),
		};

		const result = await generateInlineDocuments(
			createConfig({
				sessionId: 'session-1',
				callbacks,
				sessionCustomPath: '/opt/opencode',
				sessionCustomArgs: '--fast',
				sessionCustomEnvVars: { MODE: 'integration' },
				sessionCustomModel: 'opencode-large',
			})
		);

		expect(result.success).toBe(true);
		expect(result.documents?.map((doc) => doc.filename)).toEqual([
			'Phase-01-Setup.md',
			'Phase-02-Build.md',
		]);
		expect(result.playbook).toEqual({ id: 'playbook-1', name: 'Coverage Project' });
		expect(callbacks.onStart).toHaveBeenCalledOnce();
		expect(callbacks.onProgress).toHaveBeenCalledWith('Parsing generated documents...');
		expect(callbacks.onDocumentComplete).toHaveBeenCalledTimes(2);
		expect(callbacks.onComplete).toHaveBeenCalledWith(result.documents);
		expect(maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'opencode',
				args: ['--verbose'],
				sessionCustomPath: '/opt/opencode',
				sessionCustomArgs: '--fast',
				sessionCustomEnvVars: { MODE: 'integration' },
				sessionCustomModel: 'opencode-large',
			})
		);
		expect(maestro.autorun.writeDoc).toHaveBeenCalledTimes(2);
		expect(maestro.playbooks.create).toHaveBeenCalledWith('session-1', {
			name: 'Coverage Project',
			documents: [
				{ filename: `${result.subfolderName}/Phase-01-Setup.md`, resetOnCompletion: false },
				{ filename: `${result.subfolderName}/Phase-02-Build.md`, resetOnCompletion: false },
			],
			loopEnabled: false,
			prompt: expect.stringContaining('Complete the tasks in this document'),
		});
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('supports remote generation without a local agent and propagates the SSH remote to IO', async () => {
		maestro.agents.get.mockResolvedValue(null);
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Remote.md
CONTENT:
# Remote
- [ ] Task
---END DOCUMENT---
`);

		const result = await generateInlineDocuments(
			createConfig({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			})
		);

		expect(result.success).toBe(true);
		expect(maestro.autorun.listDocs).toHaveBeenCalledWith(
			expect.stringContaining('/repo/Auto Run Docs/'),
			'remote-1'
		);
		expect(maestro.autorun.watchFolder).toHaveBeenCalledWith(
			expect.stringContaining('/repo/Auto Run Docs/'),
			'remote-1'
		);
		expect(maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'opencode',
				args: [],
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			})
		);
		expect(maestro.autorun.writeDoc).toHaveBeenCalledWith(
			expect.stringContaining('/repo/Auto Run Docs'),
			'Phase-01-Remote.md',
			expect.stringContaining('# Remote'),
			'remote-1'
		);
	});

	it('falls back to disk documents when output has no task documents', async () => {
		completeSpawnWithOutput('No marker output.');
		maestro.autorun.listDocs
			.mockResolvedValueOnce({ success: true, tree: [] })
			.mockResolvedValue({ success: true, files: ['Phase-01-Disk'] });
		maestro.autorun.readDoc.mockResolvedValueOnce({
			success: true,
			content: '# Disk\n- [ ] Disk task',
		});

		const result = await generateInlineDocuments(createConfig());

		expect(result.success).toBe(true);
		expect(result.documents?.[0]).toMatchObject({
			filename: 'Phase-01-Disk.md',
			taskCount: 1,
		});
		expect(maestro.autorun.readDoc).toHaveBeenCalledWith(
			expect.stringContaining('/repo/Auto Run Docs/'),
			'Phase-01-Disk',
			undefined
		);
		expect(consoleLog).toHaveBeenCalledWith('[InlineWizardDocGen] Found documents on disk:', 1);
	});

	it('covers unique folder conflicts, fallback prompts, and malformed document parsing', async () => {
		expect(generateWizardFolderBaseName()).toMatch(/^\d{4}-\d{2}-\d{2}-Wizard$/);
		expect(generateWizardFolderBaseName('!!!')).toMatch(/^\d{4}-\d{2}-\d{2}-Wizard$/);

		const prompt = generateDocumentPrompt(
			createConfig({
				projectName: '',
				mode: 'iterate',
				goal: undefined,
				existingDocuments: [{ filename: 'Phase-Empty.md' }],
			})
		);
		expect(prompt).toContain('this project');
		expect(prompt).toContain('(Content not loaded)');
		expect(prompt).toContain('(No specific goal provided)');

		const emptyDocsPrompt = generateDocumentPrompt(
			createConfig({ mode: 'iterate', existingDocuments: [] })
		);
		expect(emptyDocsPrompt).toContain('(No existing documents found)');

		expect(
			parseGeneratedDocuments(`
---BEGIN DOCUMENT---
CONTENT:
# Missing filename
---END DOCUMENT---
---BEGIN DOCUMENT---
FILENAME: Phase-03-Missing-Content.md
---END DOCUMENT---
`)
		).toEqual([]);

		maestro.autorun.listDocs.mockResolvedValueOnce({ success: false });
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Base.md
CONTENT:
# Base
- [ ] Base
---END DOCUMENT---
`);
		await generateInlineDocuments(createConfig({ projectName: 'Base' }));
		expect(maestro.autorun.writeDoc).toHaveBeenCalledWith(
			expect.stringMatching(/\/Auto Run Docs\/\d{4}-\d{2}-\d{2}-Base$/),
			'Phase-01-Base.md',
			expect.any(String),
			undefined
		);
	});

	it('suffixes local subfolders when the generated folder name already exists', async () => {
		const baseName = generateWizardFolderBaseName('Coverage Project');
		maestro.autorun.listDocs.mockResolvedValueOnce({
			success: true,
			tree: [{ name: baseName }, { name: `${baseName}-2` }, { name: `${baseName}-3` }],
		});
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Unique.md
CONTENT:
# Unique
- [ ] Unique
---END DOCUMENT---
`);

		const result = await generateInlineDocuments(createConfig());

		expect(result.success).toBe(true);
		expect(result.subfolderName).toBe(`${baseName}-4`);
	});

	it('parses codex and claude stream results and builds their agent arguments', async () => {
		maestro.agents.get.mockResolvedValueOnce({
			id: 'codex',
			available: true,
			command: 'codex',
			args: ['--sandbox', 'workspace-write'],
		});
		completeSpawnWithOutput(
			[
				JSON.stringify({
					type: 'agent_message',
					content: [
						{
							type: 'text',
							text: `---BEGIN DOCUMENT---
FILENAME: Phase-01-Codex.md
CONTENT:
# Codex
- [ ] Codex task
---END DOCUMENT---`,
						},
					],
				}),
				'',
				JSON.stringify({ type: 'message', text: ' trailing status' }),
				'not-json',
			].join('\n')
		);

		const codexResult = await generateInlineDocuments(createConfig({ agentType: 'codex' }));
		expect(codexResult.documents?.[0].filename).toBe('Phase-01-Codex.md');
		expect(maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ command: 'codex', args: ['--sandbox', 'workspace-write'] })
		);

		installMaestro();
		maestro.agents.get.mockResolvedValueOnce({
			id: 'claude-code',
			available: true,
			command: 'claude',
			args: ['--model', 'sonnet'],
		});
		completeSpawnWithOutput(
			JSON.stringify({
				type: 'result',
				result: `---BEGIN DOCUMENT---
FILENAME: Phase-01-Claude.md
CONTENT:
# Claude
- [ ] Claude task
---END DOCUMENT---`,
			})
		);

		const claudeResult = await generateInlineDocuments(createConfig({ agentType: 'claude-code' }));
		expect(claudeResult.documents?.[0].filename).toBe('Phase-01-Claude.md');
		expect(maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'claude',
				args: [
					'--model',
					'sonnet',
					'--include-partial-messages',
					'--allowedTools',
					'Read',
					'Glob',
					'Grep',
					'LS',
					'Write',
				],
			})
		);

		installMaestro();
		maestro.agents.get.mockResolvedValueOnce({
			id: 'custom-agent',
			available: true,
			command: 'custom-agent',
			args: ['--plain'],
		});
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Custom.md
CONTENT:
# Custom
- [ ] Custom task
---END DOCUMENT---
`);

		await generateInlineDocuments(
			createConfig({ agentType: 'custom-agent' as DocumentGenerationConfig['agentType'] })
		);
		expect(maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ command: 'custom-agent', args: ['--plain'] })
		);
	});

	it('returns file-watcher documents, deduplicates them, and creates watcher playbooks', async () => {
		const callbacks = {
			onProgress: vi.fn(),
			onDocumentComplete: vi.fn(),
			onComplete: vi.fn(),
		};
		maestro.fs.readFile.mockImplementation(async (path: string) =>
			path.includes('Phase-01') ? '# Watcher One\n- [ ] Task' : '# Watcher Two\n- [ ] Task'
		);
		maestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
			setTimeout(() => {
				const folderPath = maestro.autorun.watchFolder.mock.calls.at(-1)?.[0] as string;
				capturedFileChangedCallback?.({
					folderPath,
					filename: 'Phase-02-Watcher',
					eventType: 'rename',
				});
				setTimeout(() => {
					capturedFileChangedCallback?.({
						folderPath,
						filename: 'Phase-01-Watcher',
						eventType: 'rename',
					});
				}, 5);
				setTimeout(() => {
					capturedFileChangedCallback?.({
						folderPath,
						filename: 'Phase-02-Watcher',
						eventType: 'change',
					});
				}, 10);
				setTimeout(() => capturedExitCallback?.(sessionId, 0), 30);
			}, 0);
		});

		const result = await generateInlineDocuments(
			createConfig({ sessionId: 'session-1', callbacks })
		);

		expect(result.success).toBe(true);
		expect(result.documents?.map((doc) => doc.filename)).toEqual([
			'Phase-01-Watcher.md',
			'Phase-02-Watcher.md',
		]);
		expect(result.playbook).toEqual({ id: 'playbook-1', name: 'Coverage Project' });
		expect(callbacks.onDocumentComplete).toHaveBeenCalledTimes(2);
		expect(callbacks.onComplete).toHaveBeenCalledWith(result.documents);
		expect(consoleLog).toHaveBeenCalledWith(
			'[InlineWizardDocGen] Using documents from emitter:',
			2
		);
	});

	it('keeps watcher documents when watcher playbook creation fails', async () => {
		maestro.fs.readFile.mockResolvedValue('# Watcher\n- [ ] Task');
		maestro.playbooks.create.mockResolvedValueOnce({ success: false });
		maestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
			setTimeout(() => {
				const folderPath = maestro.autorun.watchFolder.mock.calls.at(-1)?.[0] as string;
				capturedFileChangedCallback?.({
					folderPath,
					filename: 'Phase-01-Watcher',
					eventType: 'rename',
				});
				setTimeout(() => capturedExitCallback?.(sessionId, 0), 20);
			}, 0);
		});

		const result = await generateInlineDocuments(createConfig({ sessionId: 'session-1' }));

		expect(result.success).toBe(true);
		expect(result.playbook).toBeUndefined();
		expect(consoleError).toHaveBeenCalledWith(
			'[InlineWizardDocGen] Failed to create playbook:',
			expect.any(Error)
		);
	});

	it('logs watcher setup failures and read retry exhaustion without blocking parsed output', async () => {
		maestro.autorun.watchFolder.mockResolvedValueOnce({ success: false, error: 'watch denied' });
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Watch-Fallback.md
CONTENT:
# Fallback
- [ ] Fallback
---END DOCUMENT---
`);
		await generateInlineDocuments(createConfig());
		expect(consoleWarn).toHaveBeenCalledWith(
			'[InlineWizardDocGen] Could not watch folder:',
			'watch denied'
		);

		installMaestro();
		maestro.autorun.watchFolder.mockRejectedValueOnce(new Error('watch exploded'));
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Watch-Error.md
CONTENT:
# Fallback
- [ ] Fallback
---END DOCUMENT---
`);
		await generateInlineDocuments(createConfig());
		expect(consoleWarn).toHaveBeenCalledWith(
			'[InlineWizardDocGen] Error setting up folder watcher:',
			expect.any(Error)
		);

		installMaestro();
		maestro.fs.readFile.mockRejectedValue(new Error('still writing'));
		maestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
			setTimeout(() => {
				const folderPath = maestro.autorun.watchFolder.mock.calls.at(-1)?.[0] as string;
				capturedFileChangedCallback?.({
					folderPath,
					filename: 'Phase-01-Unreadable.md',
					eventType: 'rename',
				});
				setTimeout(() => capturedExitCallback?.(sessionId, 0), 710);
			}, 0);
		});
		maestro.autorun.listDocs
			.mockResolvedValueOnce({ success: true, tree: [] })
			.mockResolvedValueOnce({
				success: false,
			});

		const result = await generateInlineDocuments(createConfig());
		expect(result).toMatchObject({
			success: false,
			error: 'No documents were generated. Please try again.',
		});
		expect(consoleLog).toHaveBeenCalledWith(
			expect.stringContaining(
				'[PlaybookEmitter] read attempt 1/5 failed for Phase-01-Unreadable.md:'
			),
			expect.any(Error)
		);
	});

	it('reports generation timeouts and kills the active process', async () => {
		vi.useFakeTimers();
		maestro.process.spawn.mockResolvedValue(undefined);
		maestro.process.kill.mockRejectedValueOnce(new Error('kill denied'));
		maestro.autorun.unwatchFolder.mockRejectedValueOnce(new Error('unwatch denied'));
		const timeoutResult = generateInlineDocuments(createConfig());

		await vi.advanceTimersByTimeAsync(1200000);
		await expect(timeoutResult).resolves.toMatchObject({
			success: false,
			error: 'Generation timed out after 20 minutes. Please try again.',
		});
		expect(maestro.process.kill).toHaveBeenCalled();

		installMaestro();
		maestro.process.kill.mockRejectedValueOnce(new Error('kill denied'));
		maestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
			capturedDataCallback?.(sessionId, 'partial');
		});
		const inactivityResult = generateInlineDocuments(createConfig());

		await vi.advanceTimersByTimeAsync(1200000);
		await expect(inactivityResult).resolves.toMatchObject({
			success: false,
			error: 'Generation timed out after 20 minutes of inactivity. Please try again.',
			rawOutput: 'partial',
		});
		expect(maestro.process.kill).toHaveBeenCalled();
	});

	it('continues after individual save failures and reports when no documents save', async () => {
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Fail.md
CONTENT:
# Fail
- [ ] Fail
---END DOCUMENT---
---BEGIN DOCUMENT---
FILENAME: Phase-02-Save.md
CONTENT:
# Save
- [ ] Save
---END DOCUMENT---
`);
		maestro.autorun.writeDoc
			.mockResolvedValueOnce({ success: false, error: 'disk denied' })
			.mockResolvedValueOnce({ success: true });

		const partial = await generateInlineDocuments(createConfig());

		expect(partial.success).toBe(true);
		expect(partial.documents?.map((doc) => doc.filename)).toEqual(['Phase-02-Save.md']);
		expect(consoleError).toHaveBeenCalledWith(
			'[InlineWizardDocGen] Failed to save document:',
			'Phase-01-Fail.md',
			expect.any(Error)
		);

		installMaestro();
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-No-Save.md
CONTENT:
# No Save
- [ ] No Save
---END DOCUMENT---
`);
		maestro.autorun.writeDoc.mockResolvedValue({ success: false });

		const failed = await generateInlineDocuments(createConfig());
		expect(failed).toEqual({
			success: false,
			error: 'Failed to save any documents. Please check permissions and try again.',
		});
	});

	it('keeps generated documents when playbook creation fails', async () => {
		completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Playbook.md
CONTENT:
# Playbook
- [ ] Playbook
---END DOCUMENT---
`);
		maestro.playbooks.create.mockResolvedValueOnce({ success: false });

		const result = await generateInlineDocuments(createConfig({ sessionId: 'session-1' }));

		expect(result.success).toBe(true);
		expect(result.playbook).toBeUndefined();
		expect(consoleError).toHaveBeenCalledWith(
			'[InlineWizardDocGen] Failed to create playbook:',
			expect.any(Error)
		);
	});

	it('handles disk fallback list, read, and sort edge cases', async () => {
		completeSpawnWithOutput('No marker output.');
		maestro.autorun.listDocs.mockResolvedValueOnce({ success: true, tree: [] }).mockResolvedValue({
			success: true,
			files: ['Notes.md', 'Phase-02-Disk.md', 'Phase-01-Disk'],
		});
		maestro.autorun.readDoc
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true, content: '# Two\n- [ ] Two' })
			.mockResolvedValueOnce({ success: true, content: '# One\n- [ ] One' });

		const result = await generateInlineDocuments(createConfig());

		expect(result.documents?.map((doc) => doc.filename)).toEqual([
			'Phase-01-Disk.md',
			'Phase-02-Disk.md',
		]);

		installMaestro();
		completeSpawnWithOutput('');
		maestro.autorun.listDocs
			.mockResolvedValueOnce({ success: true, tree: [] })
			.mockRejectedValue(new Error('disk gone'));

		const failed = await generateInlineDocuments(createConfig());
		expect(failed).toMatchObject({
			success: false,
			error: 'No documents were generated. Please try again.',
		});
		expect(consoleError).toHaveBeenCalledWith(
			'[InlineWizardDocGen] Error reading documents from disk:',
			expect.any(Error)
		);
	});

	it('reports unavailable agents, spawn failures, and process exit failures', async () => {
		maestro.agents.get.mockResolvedValueOnce(null);
		await expect(generateInlineDocuments(createConfig())).resolves.toEqual({
			success: false,
			error: 'Agent opencode is not available',
		});

		installMaestro();
		maestro.agents.get.mockResolvedValueOnce({ id: 'opencode', available: false });
		const unavailableError = vi.fn();

		await expect(
			generateInlineDocuments(createConfig({ callbacks: { onError: unavailableError } }))
		).resolves.toEqual({
			success: false,
			error: 'Agent opencode is not available',
		});
		expect(unavailableError).toHaveBeenCalledWith('Agent opencode is not available');

		installMaestro();
		maestro.process.spawn.mockRejectedValueOnce(new Error('spawn failed'));
		const spawnError = vi.fn();
		const spawnResult = await generateInlineDocuments(
			createConfig({ callbacks: { onError: spawnError } })
		);
		expect(spawnResult).toMatchObject({
			success: false,
			error: 'Failed to spawn agent: spawn failed',
			rawOutput: '',
		});
		expect(spawnError).toHaveBeenCalledWith('Failed to spawn agent: spawn failed');

		installMaestro();
		completeSpawnWithOutput('partial output', 2);
		const exitError = vi.fn();
		const exitResult = await generateInlineDocuments(
			createConfig({ callbacks: { onError: exitError } })
		);
		expect(exitResult).toMatchObject({
			success: false,
			error: 'Agent exited with code 2',
			rawOutput: 'partial output',
		});
		expect(exitError).toHaveBeenCalledWith('Agent exited with code 2');
		expect(consoleWarn).not.toHaveBeenCalledWith(
			'[InlineWizardDocGen] Error setting up folder watcher:',
			expect.anything()
		);
	});
});
