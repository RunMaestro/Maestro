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

import { afterEach, describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
	generateDocumentGenerationPrompt,
	parseGeneratedDocuments,
	splitIntoPhases,
	countTasks,
	validateDocuments,
	sanitizeFilename,
	deriveSshRemoteId,
	wizardDebugLogger,
	phaseGenerator,
	type GenerationConfig,
} from '../../../../../renderer/components/Wizard/services/phaseGenerator';

type DataListener = (sessionId: string, data: string) => void;
type ExitListener = (sessionId: string, code: number) => void;
type FileChangedListener = (data: {
	folderPath: string;
	filename: string;
	eventType: 'rename' | 'change' | 'unlink';
}) => void;

let dataListener: DataListener | undefined;
let exitListener: ExitListener | undefined;
let fileChangedListener: FileChangedListener | undefined;
const originalMaestro = window.maestro;

const createGenerationConfig = (overrides: Partial<GenerationConfig> = {}): GenerationConfig => ({
	agentType: 'claude-code',
	directoryPath: '/repo',
	projectName: 'Wizard Project',
	conversationHistory: [{ role: 'user', content: 'Build the first useful version.' }],
	...overrides,
});

const createMarkedDocumentOutput = () => `---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Phase 1: Setup

Create the first usable version.

## Tasks
- [ ] Create the scaffold
- [ ] Verify the build
---END DOCUMENT---`;

const setupMaestroMock = () => {
	dataListener = undefined;
	exitListener = undefined;
	fileChangedListener = undefined;

	const dataCleanup = vi.fn();
	const exitCleanup = vi.fn();
	const fileCleanup = vi.fn();

	const maestro = {
		agents: {
			get: vi.fn().mockResolvedValue({
				command: 'claude',
				path: '/usr/local/bin/claude',
				args: ['--verbose'],
				available: true,
			}),
		},
		process: {
			onData: vi.fn((listener: DataListener) => {
				dataListener = listener;
				return dataCleanup;
			}),
			onExit: vi.fn((listener: ExitListener) => {
				exitListener = listener;
				return exitCleanup;
			}),
			spawn: vi.fn().mockResolvedValue(undefined),
			kill: vi.fn().mockResolvedValue(undefined),
		},
		autorun: {
			watchFolder: vi.fn().mockResolvedValue({ success: true }),
			onFileChanged: vi.fn((listener: FileChangedListener) => {
				fileChangedListener = listener;
				return fileCleanup;
			}),
			unwatchFolder: vi.fn().mockResolvedValue(undefined),
			listDocs: vi.fn().mockResolvedValue({ success: false }),
			readDoc: vi.fn(),
			writeDoc: vi.fn().mockResolvedValue({ success: true }),
		},
		fs: {
			readFile: vi.fn().mockResolvedValue('# Phase 1: Setup\n\n## Tasks\n- [ ] Default'),
		},
	};

	window.maestro = maestro as unknown as typeof window.maestro;

	return { maestro, dataCleanup, exitCleanup, fileCleanup };
};

const waitForSpawn = async (maestro: ReturnType<typeof setupMaestroMock>['maestro']) => {
	await waitFor(() => expect(maestro.process.spawn).toHaveBeenCalled());
	return maestro.process.spawn.mock.calls.at(-1)?.[0] as { sessionId: string };
};

const GENERATION_TIMEOUT_MS = 1_200_000;

const flushPromises = async (cycles = 5) => {
	for (let i = 0; i < cycles; i++) {
		await Promise.resolve();
	}
};

describe('phaseGenerator', () => {
	afterEach(() => {
		phaseGenerator.abort();
		wizardDebugLogger.clear();
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	describe('generateDocumentGenerationPrompt', () => {
		it('should substitute wizard project, folder, directory, and conversation variables', () => {
			const config: GenerationConfig = {
				agentType: 'claude-code',
				directoryPath: '/repo/project',
				projectName: 'Inventory Planner',
				subfolder: 'Initiation',
				conversationHistory: [
					{ role: 'user', content: 'We need stock forecasting.' },
					{ role: 'assistant', content: 'We should start with ingestion.' },
					{ role: 'system', content: 'Internal instruction that should not appear.' },
				],
			};

			const prompt = generateDocumentGenerationPrompt(config);

			expect(prompt).toContain('Inventory Planner');
			expect(prompt).toContain('/repo/project');
			expect(prompt).toContain('Auto Run Docs/Initiation');
			expect(prompt).toContain('User: We need stock forecasting.');
			expect(prompt).toContain('Assistant: We should start with ingestion.');
			expect(prompt).not.toContain('Internal instruction that should not appear.');
		});

		it('should fall back to generic project display and root Auto Run folder', () => {
			const prompt = generateDocumentGenerationPrompt({
				agentType: 'claude-code',
				directoryPath: '/repo/project',
				projectName: '',
				conversationHistory: [],
			});

			expect(prompt).toContain('this project');
			expect(prompt).toContain('Auto Run Docs');
			expect(prompt).not.toContain('Auto Run Docs/Initiation');
		});
	});

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

		it('should skip empty document blocks and default phase to zero when filename has no phase', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Notes.md
CONTENT:
# Notes

## Tasks
- [ ] Capture notes
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME:
CONTENT:
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(1);
			expect(docs[0]).toMatchObject({
				filename: 'Notes.md',
				phase: 0,
			});
		});

		it('should skip document blocks that have content but no filename', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME:
CONTENT:
# Phase 1

## Tasks
- [ ] Build
---END DOCUMENT---
`;

			expect(parseGeneratedDocuments(output)).toEqual([]);
		});

		it('should skip document blocks that have a filename but no content', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
---END DOCUMENT---
`;

			expect(parseGeneratedDocuments(output)).toEqual([]);
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

All files have been saved to the Auto Run Docs folder.`;

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

		it('should use Tasks when a phase heading has no description', () => {
			const docs = splitIntoPhases(`# Phase 1

## Tasks
- [ ] Start`);

			expect(docs).toHaveLength(1);
			expect(docs[0].filename).toBe('Phase-01-Tasks.md');
		});

		it('should remove punctuation from generated phase filenames', () => {
			const docs = splitIntoPhases(`# Phase 1: Build API & UI!

## Tasks
- [ ] Start`);

			expect(docs[0].filename).toBe('Phase-01-Build-API-UI.md');
		});

		it('should return no documents for blank content', () => {
			expect(splitIntoPhases('   \n\t')).toEqual([]);
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

		it('should report missing phase headers and missing tasks sections', () => {
			const result = validateDocuments([
				{
					filename: 'Phase-01-Notes.md',
					content: `Implementation notes

- [ ] A task without the expected heading`,
					phase: 1,
				},
			]);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Phase-01-Notes.md is missing a phase header');
			expect(result.errors).toContain('Phase-01-Notes.md is missing a Tasks section');
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

	describe('deriveSshRemoteId', () => {
		it('should derive remote id only when SSH is enabled', () => {
			expect(deriveSshRemoteId({ enabled: true, remoteId: 'remote-1' })).toBe('remote-1');
			expect(deriveSshRemoteId({ enabled: true, remoteId: null })).toBeUndefined();
			expect(deriveSshRemoteId({ enabled: false, remoteId: 'remote-1' })).toBeUndefined();
			expect(deriveSshRemoteId()).toBeUndefined();
		});
	});

	describe('wizardDebugLogger', () => {
		it('should record session metadata, trim old logs, and export a summary', () => {
			vi.spyOn(Date, 'now').mockImplementation(() => 1200);
			wizardDebugLogger.startSession({
				agentType: 'claude-code',
				directoryPath: '/repo',
				projectName: 'Debug Project',
				conversationHistory: [
					{ role: 'user', content: 'x'.repeat(120) },
					{ role: 'assistant', content: 'Short answer' },
					{ role: 'user', content: 'Third message' },
					{ role: 'assistant', content: 'Not included in preview' },
				],
			});

			for (let i = 0; i < 10005; i++) {
				wizardDebugLogger.log(i % 2 === 0 ? 'data' : 'file', `entry-${i}`);
			}
			wizardDebugLogger.log('error', 'failed chunk');

			const logs = wizardDebugLogger.getLogs();
			expect(logs.length).toBeLessThan(10000);
			expect(logs.at(-1)?.message).toBe('failed chunk');

			const exported = wizardDebugLogger.exportLogs();
			expect(exported.sessionInfo).toMatchObject({
				agentType: 'claude-code',
				directoryPath: '/repo',
				projectName: 'Debug Project',
				conversationHistoryLength: 4,
			});
			expect(exported.sessionInfo.conversationHistoryPreview).toHaveLength(3);
			expect(exported.summary.totalLogs).toBe(logs.length);
			expect(exported.summary.logsByType.error).toBe(1);
			expect(exported.summary.dataChunksReceived).toBeGreaterThan(0);
			expect(exported.summary.filesDetected).toBeGreaterThan(0);
			expect(exported.summary.errors).toEqual(['failed chunk']);
		});

		it('should export unknown navigator metadata outside a browser-like environment', () => {
			const originalNavigator = globalThis.navigator;
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				value: undefined,
			});

			try {
				wizardDebugLogger.startSession({
					agentType: 'claude-code',
					directoryPath: '/repo',
					projectName: 'Debug Project',
					conversationHistory: [],
				});

				expect(wizardDebugLogger.exportLogs().sessionInfo).toMatchObject({
					userAgent: 'unknown',
					platform: 'unknown',
				});
			} finally {
				Object.defineProperty(globalThis, 'navigator', {
					configurable: true,
					value: originalNavigator,
				});
			}
		});

		it('should download logs as a JSON blob and clear logger state', () => {
			wizardDebugLogger.startSession({
				agentType: 'claude-code',
				directoryPath: '/repo',
				projectName: 'Debug Project',
				conversationHistory: [],
			});
			wizardDebugLogger.log('info', 'download me');
			const appendSpy = vi.spyOn(document.body, 'appendChild');
			const removeSpy = vi.spyOn(document.body, 'removeChild');
			const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:debug');
			const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
			const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

			wizardDebugLogger.downloadLogs();

			expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
			expect(appendSpy).toHaveBeenCalledWith(expect.any(HTMLAnchorElement));
			expect(clickSpy).toHaveBeenCalled();
			expect(removeSpy).toHaveBeenCalledWith(expect.any(HTMLAnchorElement));
			expect(revokeObjectUrl).toHaveBeenCalledWith('blob:debug');

			wizardDebugLogger.clear();

			expect(wizardDebugLogger.getLogs()).toEqual([]);
			expect(wizardDebugLogger.exportLogs().sessionInfo).toMatchObject({
				startTime: 0,
			});
		});
	});

	describe('phaseGenerator service orchestration', () => {
		it('should expose path/status helpers and reject concurrent generation attempts', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});

			expect(phaseGenerator.getAutoRunPath('/repo')).toBe('/repo/Auto Run Docs');

			const firstRun = phaseGenerator.generateDocuments(createGenerationConfig());
			const spawnCall = await waitForSpawn(maestro);

			expect(phaseGenerator.isGenerationInProgress()).toBe(true);

			const secondRun = await phaseGenerator.generateDocuments(createGenerationConfig());

			expect(secondRun).toEqual({
				success: false,
				error: 'Generation already in progress',
			});

			dataListener?.(spawnCall.sessionId, createMarkedDocumentOutput());
			exitListener?.(spawnCall.sessionId, 0);

			await expect(firstRun).resolves.toMatchObject({ success: true });
			expect(phaseGenerator.isGenerationInProgress()).toBe(false);
		});

		it('should parse stream-json result output, pass claude generation args, and complete callbacks', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const callbacks = {
				onStart: vi.fn(),
				onProgress: vi.fn(),
				onChunk: vi.fn(),
				onComplete: vi.fn(),
				onActivity: vi.fn(),
			};

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);
			const spawnCall = await waitForSpawn(maestro);
			await waitFor(() => expect(maestro.autorun.onFileChanged).toHaveBeenCalled());

			dataListener?.(
				spawnCall.sessionId,
				`status line\n${JSON.stringify({
					type: 'result',
					result: createMarkedDocumentOutput(),
				})}\n`
			);
			exitListener?.(spawnCall.sessionId, 0);

			const result = await promise;

			expect(result).toMatchObject({
				success: true,
				documentsFromDisk: false,
			});
			expect(result.documents).toHaveLength(1);
			expect(result.documents?.[0]).toMatchObject({
				filename: 'Phase-01-Setup.md',
				taskCount: 2,
				savedPath: undefined,
			});
			expect(callbacks.onStart).toHaveBeenCalled();
			expect(callbacks.onChunk).toHaveBeenCalled();
			expect(callbacks.onActivity).toHaveBeenCalled();
			expect(callbacks.onComplete).toHaveBeenCalledWith(result);
			expect(maestro.autorun.listDocs).not.toHaveBeenCalled();
			expect(maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: spawnCall.sessionId,
					toolType: 'claude-code',
					cwd: '/repo',
					command: '/usr/local/bin/claude',
					args: expect.arrayContaining([
						'--verbose',
						'--include-partial-messages',
						'--allowedTools',
						'Read',
						'Glob',
						'Grep',
						'LS',
						'Write',
					]),
				})
			);
		});

		it('should avoid duplicate claude generation args and support agents without base args', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			maestro.agents.get.mockResolvedValue({
				command: 'claude',
				available: true,
				args: [
					'--include-partial-messages',
					'--allowedTools',
					'Read',
					'Glob',
					'Grep',
					'LS',
					'Write',
				],
			});

			const promise = phaseGenerator.generateDocuments(createGenerationConfig());
			const spawnCall = await waitForSpawn(maestro);

			expect(
				spawnCall.args.filter((arg: string) => arg === '--include-partial-messages')
			).toHaveLength(1);
			expect(spawnCall.args.filter((arg: string) => arg === '--allowedTools')).toHaveLength(1);

			dataListener?.(spawnCall.sessionId, createMarkedDocumentOutput());
			exitListener?.(spawnCall.sessionId, 0);
			await expect(promise).resolves.toMatchObject({ success: true });

			maestro.agents.get.mockResolvedValue({
				command: 'codex',
				available: true,
			});
			const codexPromise = phaseGenerator.generateDocuments(
				createGenerationConfig({ agentType: 'codex' })
			);
			const codexSpawn = await waitForSpawn(maestro);
			expect(codexSpawn.args).toEqual([]);
			dataListener?.(codexSpawn.sessionId, createMarkedDocumentOutput());
			exitListener?.(codexSpawn.sessionId, 0);
			await expect(codexPromise).resolves.toMatchObject({ success: true });
		});

		it('should fall back to disk documents when agent output is status text without tasks', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			maestro.agents.get.mockResolvedValue({
				command: 'claude',
				args: [],
				available: false,
			});
			maestro.autorun.listDocs.mockResolvedValue({
				success: true,
				files: ['Phase-02-Build', 'Phase-01-Setup.md', 'Notes'],
			});
			maestro.autorun.readDoc.mockImplementation(async (_path, filename) => {
				if (filename === 'Notes') {
					return { success: false };
				}
				return {
					success: true,
					content:
						filename === 'Phase-01-Setup.md'
							? '# Phase 1: Setup\n\n## Tasks\n- [ ] Prepare'
							: '# Phase 2: Build\n\n## Tasks\n- [ ] Build',
				};
			});
			const callbacks = { onProgress: vi.fn(), onComplete: vi.fn() };

			const promise = phaseGenerator.generateDocuments(
				createGenerationConfig({
					subfolder: 'Initiation',
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				}),
				callbacks
			);
			const spawnCall = await waitForSpawn(maestro);

			dataListener?.(
				spawnCall.sessionId,
				'Created Phase-01-Setup.md and Phase-02-Build.md in the requested folder.'
			);
			exitListener?.(spawnCall.sessionId, 0);

			const result = await promise;

			expect(result.success).toBe(true);
			expect(result.documentsFromDisk).toBe(true);
			expect(result.documents?.map((doc) => doc.filename)).toEqual([
				'Phase-01-Setup.md',
				'Phase-02-Build.md',
			]);
			expect(maestro.autorun.listDocs).toHaveBeenCalledWith(
				'/repo/Auto Run Docs/Initiation',
				'remote-1'
			);
			expect(maestro.autorun.readDoc).toHaveBeenCalledWith(
				'/repo/Auto Run Docs/Initiation',
				'Phase-02-Build',
				'remote-1'
			);
			expect(callbacks.onProgress).toHaveBeenCalledWith('Checking for documents on disk...');
			expect(callbacks.onComplete).toHaveBeenCalledWith(result);
		});

		it('should read disk documents without phase numbers as phase zero', async () => {
			const { maestro } = setupMaestroMock();
			const manager = phaseGenerator as unknown as {
				readDocumentsFromDisk: (
					path: string,
					remoteId?: string
				) => Promise<
					Array<{
						filename: string;
						content: string;
						phase: number;
					}>
				>;
			};
			maestro.autorun.listDocs.mockResolvedValue({
				success: true,
				files: ['Notes'],
			});
			maestro.autorun.readDoc.mockResolvedValue({
				success: true,
				content: '# Notes\n\n## Tasks\n- [ ] Capture',
			});

			await expect(
				manager.readDocumentsFromDisk('/repo/Auto Run Docs', 'remote-1')
			).resolves.toEqual([
				{
					filename: 'Notes.md',
					content: '# Notes\n\n## Tasks\n- [ ] Capture',
					phase: 0,
				},
			]);
			expect(maestro.autorun.readDoc).toHaveBeenCalledWith(
				'/repo/Auto Run Docs',
				'Notes',
				'remote-1'
			);
		});

		it('should report missing and unavailable agent configuration before spawning', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.agents.get.mockResolvedValueOnce(null);

			const missing = await phaseGenerator.generateDocuments(createGenerationConfig());

			expect(missing.success).toBe(false);
			expect(missing.error).toBe('Agent claude-code configuration not found');
			expect(maestro.process.spawn).not.toHaveBeenCalled();

			maestro.agents.get.mockResolvedValueOnce({
				command: 'claude',
				args: [],
				available: false,
				customPath: '/bad/claude',
			});

			const unavailable = await phaseGenerator.generateDocuments(createGenerationConfig());

			expect(unavailable.success).toBe(false);
			expect(unavailable.error).toContain('The custom path "/bad/claude" is not valid');
			expect(maestro.process.spawn).not.toHaveBeenCalled();

			maestro.agents.get.mockResolvedValueOnce({
				command: 'claude',
				args: [],
				available: false,
			});

			const unavailableOnPath = await phaseGenerator.generateDocuments(createGenerationConfig());

			expect(unavailableOnPath.success).toBe(false);
			expect(unavailableOnPath.error).toContain('The agent was not found in your system PATH');
			expect(maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('should report a generic generation error when the agent run has no error detail', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const manager = phaseGenerator as unknown as {
				runAgent: () => Promise<{ success: boolean; rawOutput?: string }>;
			};
			vi.spyOn(manager, 'runAgent').mockResolvedValueOnce({ success: false, rawOutput: '' });
			const callbacks = { onError: vi.fn() };

			const result = await phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);

			expect(result).toEqual({ success: false, rawOutput: '' });
			expect(callbacks.onError).toHaveBeenCalledWith('Generation failed');
			expect(maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('should return thrown Error details from generation exceptions', async () => {
			setupMaestroMock();
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const manager = phaseGenerator as unknown as {
				runAgent: () => Promise<unknown>;
			};
			vi.spyOn(manager, 'runAgent').mockRejectedValueOnce(new Error('parse exploded'));
			const callbacks = { onError: vi.fn() };

			const result = await phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);

			expect(result).toEqual({
				success: false,
				error: 'parse exploded',
				rawOutput: '',
			});
			expect(callbacks.onError).toHaveBeenCalledWith('parse exploded');
		});

		it('should return unknown generation errors for non-Error exceptions', async () => {
			setupMaestroMock();
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const manager = phaseGenerator as unknown as {
				runAgent: () => Promise<unknown>;
			};
			vi.spyOn(manager, 'runAgent').mockRejectedValueOnce('parse exploded');
			const callbacks = { onError: vi.fn() };

			const result = await phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);

			expect(result).toEqual({
				success: false,
				error: 'Unknown error occurred',
				rawOutput: '',
			});
			expect(callbacks.onError).toHaveBeenCalledWith('Unknown error occurred');
		});

		it('should clean up listeners and report spawn failures', async () => {
			const { maestro, dataCleanup, exitCleanup } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.autorun.watchFolder.mockImplementation(() => new Promise(() => {}));
			maestro.process.spawn.mockRejectedValue(new Error('spawn denied'));

			const result = await phaseGenerator.generateDocuments(createGenerationConfig());

			expect(result).toEqual({
				success: false,
				error: 'Failed to spawn agent: spawn denied',
			});
			expect(dataCleanup).toHaveBeenCalled();
			expect(exitCleanup).toHaveBeenCalled();
		});

		it('should time out inactive generations, clean up watchers, and kill the process', async () => {
			vi.useFakeTimers();
			const { maestro, dataCleanup, exitCleanup, fileCleanup } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.process.kill.mockRejectedValue(new Error('already stopped'));
			maestro.autorun.unwatchFolder.mockRejectedValue(new Error('unwatch failed'));

			const promise = phaseGenerator.generateDocuments(createGenerationConfig());
			await flushPromises();
			const spawnCall = maestro.process.spawn.mock.calls.at(-1)?.[0] as { sessionId: string };
			expect(spawnCall).toBeDefined();
			expect(maestro.autorun.onFileChanged).toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
			await flushPromises();

			await expect(promise).resolves.toEqual({
				success: false,
				error: 'Generation timed out after 20 minutes of inactivity. Please try again.',
				rawOutput: '',
			});
			expect(maestro.process.kill).toHaveBeenCalledWith(spawnCall.sessionId);
			expect(dataCleanup).toHaveBeenCalled();
			expect(exitCleanup).toHaveBeenCalled();
			expect(fileCleanup).toHaveBeenCalled();
			expect(maestro.autorun.unwatchFolder).toHaveBeenCalledWith('/repo/Auto Run Docs');
		});

		it('should time out even when the file watcher never becomes ready', async () => {
			vi.useFakeTimers();
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.autorun.watchFolder.mockImplementation(() => new Promise(() => {}));

			const promise = phaseGenerator.generateDocuments(createGenerationConfig());
			await flushPromises();
			const spawnCall = maestro.process.spawn.mock.calls.at(-1)?.[0] as { sessionId: string };

			await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
			await flushPromises();

			await expect(promise).resolves.toMatchObject({
				success: false,
				error: 'Generation timed out after 20 minutes of inactivity. Please try again.',
			});
			expect(maestro.process.kill).toHaveBeenCalledWith(spawnCall.sessionId);
		});

		it('should fail when a successful agent run produces no documents anywhere', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const callbacks = { onError: vi.fn() };

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);
			const spawnCall = await waitForSpawn(maestro);

			exitListener?.(spawnCall.sessionId, 0);

			const result = await promise;

			expect(result).toEqual({
				success: false,
				error: 'Document validation failed: No documents were generated',
				rawOutput: '',
			});
			expect(callbacks.onError).toHaveBeenCalledWith(
				'Document validation failed: No documents were generated'
			);
		});

		it('should return failed generation output for non-zero agent exits', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const callbacks = { onError: vi.fn() };

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);
			const spawnCall = await waitForSpawn(maestro);

			dataListener?.(spawnCall.sessionId, 'partial output');
			exitListener?.(spawnCall.sessionId, 7);

			const result = await promise;

			expect(result).toEqual({
				success: false,
				error: 'Agent exited with code 7',
				rawOutput: 'partial output',
			});
			expect(callbacks.onError).toHaveBeenCalledWith('Agent exited with code 7');
		});

		it('should log progress every tenth data chunk', async () => {
			const { maestro } = setupMaestroMock();
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

			const promise = phaseGenerator.generateDocuments(createGenerationConfig());
			const spawnCall = await waitForSpawn(maestro);

			for (let i = 0; i < 9; i++) {
				dataListener?.(spawnCall.sessionId, `chunk-${i}\n`);
			}
			expect(consoleLog).not.toHaveBeenCalledWith('[PhaseGenerator] Progress:', expect.anything());

			dataListener?.(spawnCall.sessionId, 'chunk-9\n');

			expect(consoleLog).toHaveBeenCalledWith(
				'[PhaseGenerator] Progress:',
				expect.objectContaining({ chunks: 10 })
			);

			dataListener?.(spawnCall.sessionId, createMarkedDocumentOutput());
			exitListener?.(spawnCall.sessionId, 0);

			await expect(promise).resolves.toMatchObject({ success: true });
		});

		it('should ignore data for other sessions and exit before file watching is ready', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			maestro.autorun.watchFolder.mockImplementation(() => new Promise(() => {}));
			const callbacks = { onChunk: vi.fn() };

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);
			const spawnCall = await waitForSpawn(maestro);

			dataListener?.('other-session', 'ignored');
			exitListener?.('other-session', 0);
			expect(callbacks.onChunk).not.toHaveBeenCalled();

			dataListener?.(spawnCall.sessionId, createMarkedDocumentOutput());
			exitListener?.(spawnCall.sessionId, 0);

			await expect(promise).resolves.toMatchObject({ success: true });
		});

		it('should notify file creation from watcher events with description and task counts', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const onFileCreated = vi.fn();
			const onActivity = vi.fn();
			maestro.fs.readFile.mockResolvedValue(
				'# Phase 1: Setup\n\nCreate a focused first slice.\n\n## Tasks\n- [ ] Build it'
			);

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), {
				onFileCreated,
				onActivity,
			});
			const spawnCall = await waitForSpawn(maestro);
			await waitFor(() => expect(maestro.autorun.onFileChanged).toHaveBeenCalled());

			fileChangedListener?.({
				folderPath: '/repo/Auto Run Docs',
				filename: 'Phase-01-Setup',
				eventType: 'rename',
			});

			await waitFor(() => expect(onFileCreated).toHaveBeenCalled());
			expect(maestro.fs.readFile).toHaveBeenCalledWith(
				'/repo/Auto Run Docs/Phase-01-Setup.md',
				undefined
			);
			expect(onFileCreated).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'Phase-01-Setup.md',
					path: '/repo/Auto Run Docs/Phase-01-Setup.md',
					description: 'Create a focused first slice.',
					taskCount: 1,
				})
			);
			expect(onActivity).toHaveBeenCalled();

			dataListener?.(spawnCall.sessionId, createMarkedDocumentOutput());
			exitListener?.(spawnCall.sessionId, 0);
			await expect(promise).resolves.toMatchObject({ success: true });
		});

		it('should ignore unrelated watcher events and fall back when file content is empty', async () => {
			vi.useFakeTimers();
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const onFileCreated = vi.fn();
			const onActivity = vi.fn();
			maestro.fs.readFile.mockResolvedValue('');

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), {
				onFileCreated,
				onActivity,
			});
			await flushPromises();
			const spawnCall = maestro.process.spawn.mock.calls.at(-1)?.[0] as { sessionId: string };
			expect(spawnCall).toBeDefined();

			fileChangedListener?.({
				folderPath: '/repo/Other Folder',
				filename: 'Phase-01-Setup',
				eventType: 'change',
			});
			fileChangedListener?.({
				folderPath: '/repo/Auto Run Docs',
				filename: '',
				eventType: 'change',
			});
			fileChangedListener?.({
				folderPath: '/repo/Auto Run Docs',
				filename: 'Phase-01-Setup',
				eventType: 'unlink',
			});
			expect(maestro.fs.readFile).not.toHaveBeenCalled();

			fileChangedListener?.({
				folderPath: '/repo/Auto Run Docs',
				filename: 'Phase-01-Setup',
				eventType: 'change',
			});
			await vi.advanceTimersByTimeAsync(1_000);
			await flushPromises();

			expect(onActivity).toHaveBeenCalledTimes(3);
			expect(onFileCreated).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'Phase-01-Setup.md',
					size: 0,
				})
			);

			dataListener?.(spawnCall.sessionId, createMarkedDocumentOutput());
			exitListener?.(spawnCall.sessionId, 0);
			await expect(promise).resolves.toMatchObject({ success: true });
		});

		it('should notify file creation without size after file read retries fail', async () => {
			vi.useFakeTimers();
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const onFileCreated = vi.fn();
			maestro.fs.readFile.mockRejectedValue(new Error('file still writing'));

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), { onFileCreated });
			await flushPromises();
			const spawnCall = maestro.process.spawn.mock.calls.at(-1)?.[0] as { sessionId: string };
			expect(spawnCall).toBeDefined();
			expect(maestro.autorun.onFileChanged).toHaveBeenCalled();

			fileChangedListener?.({
				folderPath: '/repo/Auto Run Docs',
				filename: 'Phase-01-Setup.md',
				eventType: 'change',
			});

			await vi.advanceTimersByTimeAsync(1_000);
			await flushPromises();

			expect(onFileCreated).toHaveBeenCalled();
			expect(maestro.fs.readFile).toHaveBeenCalledTimes(3);
			expect(onFileCreated).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'Phase-01-Setup.md',
					path: '/repo/Auto Run Docs/Phase-01-Setup.md',
					size: 0,
				})
			);

			dataListener?.(spawnCall.sessionId, createMarkedDocumentOutput());
			exitListener?.(spawnCall.sessionId, 0);
			await expect(promise).resolves.toMatchObject({ success: true });
		});

		it('should continue when folder watching is unavailable or setup throws', async () => {
			const { maestro } = setupMaestroMock();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			vi.spyOn(console, 'log').mockImplementation(() => {});

			maestro.autorun.watchFolder.mockResolvedValueOnce({
				success: false,
				error: 'permission denied',
			});
			const failedWatch = phaseGenerator.generateDocuments(createGenerationConfig());
			const failedWatchSpawn = await waitForSpawn(maestro);
			await waitFor(() =>
				expect(consoleWarn).toHaveBeenCalledWith(
					'[PhaseGenerator] Could not watch folder:',
					'permission denied'
				)
			);
			dataListener?.(failedWatchSpawn.sessionId, createMarkedDocumentOutput());
			exitListener?.(failedWatchSpawn.sessionId, 0);
			await expect(failedWatch).resolves.toMatchObject({ success: true });

			consoleWarn.mockClear();
			maestro.autorun.watchFolder.mockRejectedValueOnce(new Error('watch failed'));
			const thrownWatch = phaseGenerator.generateDocuments(createGenerationConfig());
			const thrownWatchSpawn = await waitForSpawn(maestro);
			await waitFor(() =>
				expect(consoleWarn).toHaveBeenCalledWith(
					'[PhaseGenerator] Error setting up folder watcher:',
					expect.any(Error)
				)
			);
			dataListener?.(thrownWatchSpawn.sessionId, createMarkedDocumentOutput());
			exitListener?.(thrownWatchSpawn.sessionId, 0);
			await expect(thrownWatch).resolves.toMatchObject({ success: true });
		});

		it('should clean up file watcher registration when spawn fails after watching starts', async () => {
			const { maestro, fileCleanup } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.process.spawn.mockRejectedValue(new Error('spawn denied'));

			const result = await phaseGenerator.generateDocuments(createGenerationConfig());

			expect(result).toEqual({
				success: false,
				error: 'Failed to spawn agent: spawn denied',
			});
			expect(fileCleanup).toHaveBeenCalled();
		});

		it('should proceed with parsed status output when disk listing is unavailable', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const callbacks = { onProgress: vi.fn(), onComplete: vi.fn() };

			const promise = phaseGenerator.generateDocuments(createGenerationConfig(), callbacks);
			const spawnCall = await waitForSpawn(maestro);

			dataListener?.(spawnCall.sessionId, 'Created files in Auto Run Docs.');
			exitListener?.(spawnCall.sessionId, 0);

			const result = await promise;

			expect(result.success).toBe(true);
			expect(result.documentsFromDisk).toBe(false);
			expect(result.documents?.[0]).toMatchObject({
				filename: 'Phase-01-Initial-Setup.md',
				taskCount: 0,
			});
			expect(maestro.autorun.listDocs).toHaveBeenCalledWith('/repo/Auto Run Docs', undefined);
			expect(callbacks.onProgress).toHaveBeenCalledWith(
				'Note: 3 validation warning(s), proceeding anyway'
			);
		});

		it('should continue with parsed output when disk reads throw', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.autorun.listDocs.mockRejectedValue(new Error('remote list failed'));

			const promise = phaseGenerator.generateDocuments(createGenerationConfig());
			const spawnCall = await waitForSpawn(maestro);

			dataListener?.(spawnCall.sessionId, 'Created files in Auto Run Docs.');
			exitListener?.(spawnCall.sessionId, 0);

			const result = await promise;

			expect(result.success).toBe(true);
			expect(result.documentsFromDisk).toBe(false);
			expect(consoleError).toHaveBeenCalledWith(
				'[PhaseGenerator] Error reading documents from disk:',
				expect.any(Error)
			);
		});

		it('should save documents with sanitized names, subfolders, SSH context, and file metadata', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(Date, 'now').mockReturnValue(5000);
			const onFileCreated = vi.fn();
			const longDescription = 'A'.repeat(160);
			const docs = [
				{
					filename: 'nested/Phase-01 Setup',
					content: `# Phase 1: Setup\n\n${longDescription}\n\n## Tasks\n- [ ] Start`,
				},
				{
					filename: 'Phase-02-Build.md',
					content: '# Phase 2: Build\n\n## Tasks\n- [x] Done',
				},
			];

			const result = await phaseGenerator.saveDocuments(
				'/repo',
				docs,
				onFileCreated,
				'Initiation',
				'remote-1'
			);

			expect(result).toEqual({
				success: true,
				savedPaths: [
					'/repo/Auto Run Docs/Initiation/nested-Phase-01 Setup.md',
					'/repo/Auto Run Docs/Initiation/Phase-02-Build.md',
				],
				subfolderPath: '/repo/Auto Run Docs/Initiation',
			});
			expect(maestro.autorun.writeDoc).toHaveBeenNthCalledWith(
				1,
				'/repo/Auto Run Docs/Initiation',
				'nested-Phase-01 Setup.md',
				docs[0].content,
				'remote-1'
			);
			expect(docs[0].savedPath).toBe('/repo/Auto Run Docs/Initiation/nested-Phase-01 Setup.md');
			expect(onFileCreated).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					filename: 'nested-Phase-01 Setup.md',
					path: '/repo/Auto Run Docs/Initiation/nested-Phase-01 Setup.md',
					timestamp: 5000,
					description: `${'A'.repeat(147)}...`,
					taskCount: 1,
				})
			);
		});

		it('should omit file descriptions when saved content has no title heading', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const onFileCreated = vi.fn();

			const result = await phaseGenerator.saveDocuments(
				'/repo',
				[
					{
						filename: 'Phase-01-Setup.md',
						content: 'Plain opening paragraph\n\n## Tasks\n- [ ] Start',
					},
				],
				onFileCreated
			);

			expect(result.success).toBe(true);
			expect(onFileCreated).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'Phase-01-Setup.md',
					description: undefined,
					taskCount: 1,
				})
			);
			expect(maestro.autorun.writeDoc).toHaveBeenCalled();
		});

		it('should return partial saved paths when saving a later document fails', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.autorun.writeDoc
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({ success: false, error: 'disk full' });
			const docs = [
				{ filename: 'Phase-01-Setup.md', content: '# Phase 1\n\n## Tasks\n- [ ] One' },
				{ filename: 'Phase-02-Build.md', content: '# Phase 2\n\n## Tasks\n- [ ] Two' },
			];

			const result = await phaseGenerator.saveDocuments('/repo', docs);

			expect(result).toEqual({
				success: false,
				savedPaths: ['/repo/Auto Run Docs/Phase-01-Setup.md'],
				error: 'disk full',
			});
			expect(docs[0].savedPath).toBe('/repo/Auto Run Docs/Phase-01-Setup.md');
			expect(docs[1].savedPath).toBeUndefined();
		});

		it('should use a filename-specific save error when writeDoc returns no error', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.autorun.writeDoc.mockResolvedValue({ success: false });

			const result = await phaseGenerator.saveDocuments('/repo', [
				{ filename: 'Phase-01-Setup.md', content: '# Phase 1\n\n## Tasks\n- [ ] One' },
			]);

			expect(result).toEqual({
				success: false,
				savedPaths: [],
				error: 'Failed to save Phase-01-Setup.md',
			});
		});

		it('should use a generic save error when writeDoc rejects without an Error object', async () => {
			const { maestro } = setupMaestroMock();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			maestro.autorun.writeDoc.mockRejectedValue('offline');

			const result = await phaseGenerator.saveDocuments('/repo', [
				{ filename: 'Phase-01-Setup.md', content: '# Phase 1\n\n## Tasks\n- [ ] One' },
			]);

			expect(result).toEqual({
				success: false,
				savedPaths: [],
				error: 'Failed to save documents',
			});
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
