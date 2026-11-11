/**
 * Tests for inlineWizardDocumentGeneration.ts
 *
 * These tests verify the document parsing and iterate mode functionality.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
	generateInlineDocuments,
	parseGeneratedDocuments,
	splitIntoPhases,
	sanitizeFilename,
	generateWizardFolderBaseName,
	countTasks,
	generateDocumentPrompt,
	loadInlineWizardDocGenPrompts,
	createPlaybookDocumentEmitter,
	extractDisplayTextFromChunk,
	type DocumentGenerationConfig,
	type PlaybookDocumentEmitter,
} from '../../../renderer/services/inlineWizardDocumentGeneration';
import type { InlineGeneratedDocument } from '../../../renderer/hooks/batch/useInlineWizard';

describe('inlineWizardDocumentGeneration', () => {
	describe('extractDisplayTextFromChunk', () => {
		it('joins Grok text deltas and ignores thought deltas', () => {
			const chunk =
				'{"type":"thought","data":"reasoning"}\n' +
				'{"type":"text","data":"Hello "}\n' +
				'{"type":"text","data":"world"}\n' +
				'{"type":"end","stopReason":"EndTurn","sessionId":"abc"}\n';

			expect(extractDisplayTextFromChunk(chunk, 'grok')).toBe('Hello world');
		});
	});

	describe('parseGeneratedDocuments', () => {
		it('should parse documents with standard markers', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Phase 01: Setup

## Tasks

- [ ] Install dependencies
- [ ] Configure project
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(1);
			expect(docs[0].filename).toBe('Phase-01-Setup.md');
			expect(docs[0].phase).toBe(1);
			expect(docs[0].isUpdate).toBe(false);
			expect(docs[0].content).toContain('# Phase 01: Setup');
			expect(docs[0].content).toContain('- [ ] Install dependencies');
		});

		it('should parse multiple documents', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Phase 01: Setup

- [ ] Task 1
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-02-Build.md
CONTENT:
# Phase 02: Build

- [ ] Task 2
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(2);
			expect(docs[0].filename).toBe('Phase-01-Setup.md');
			expect(docs[0].phase).toBe(1);
			expect(docs[1].filename).toBe('Phase-02-Build.md');
			expect(docs[1].phase).toBe(2);
		});

		it('should detect UPDATE marker for iterate mode', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
UPDATE: true
CONTENT:
# Phase 01: Setup (Updated)

## Tasks

- [ ] Updated task 1
- [ ] New task added
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(1);
			expect(docs[0].filename).toBe('Phase-01-Setup.md');
			expect(docs[0].isUpdate).toBe(true);
			expect(docs[0].content).toContain('(Updated)');
		});

		it('should handle UPDATE: false explicitly', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-03-NewFeature.md
UPDATE: false
CONTENT:
# Phase 03: New Feature

- [ ] New task
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(1);
			expect(docs[0].isUpdate).toBe(false);
		});

		it('should handle mixed update and new documents', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
UPDATE: true
CONTENT:
# Phase 01: Setup (Updated)

- [ ] Updated task
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-03-NewFeature.md
CONTENT:
# Phase 03: New Feature

- [ ] New feature task
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(2);
			expect(docs[0].filename).toBe('Phase-01-Setup.md');
			expect(docs[0].isUpdate).toBe(true);
			expect(docs[0].phase).toBe(1);
			expect(docs[1].filename).toBe('Phase-03-NewFeature.md');
			expect(docs[1].isUpdate).toBe(false);
			expect(docs[1].phase).toBe(3);
		});

		it('should sort documents by phase number', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-03-Deploy.md
CONTENT:
# Phase 03

- [ ] Task
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Phase 01

- [ ] Task
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-02-Build.md
CONTENT:
# Phase 02

- [ ] Task
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(3);
			expect(docs[0].phase).toBe(1);
			expect(docs[1].phase).toBe(2);
			expect(docs[2].phase).toBe(3);
		});

		it('should handle documents without phase numbers in filename', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: README.md
CONTENT:
# Project README

Some content here.
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(1);
			expect(docs[0].filename).toBe('README.md');
			expect(docs[0].phase).toBe(0);
			expect(docs[0].isUpdate).toBe(false);
		});

		it('should handle empty output', () => {
			const docs = parseGeneratedDocuments('');
			expect(docs).toHaveLength(0);
		});

		it('should handle output without document markers', () => {
			const output = 'Just some random text without markers';
			const docs = parseGeneratedDocuments(output);
			expect(docs).toHaveLength(0);
		});

		it('should handle UPDATE marker case-insensitively', () => {
			const output = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
UPDATE: TRUE
CONTENT:
# Phase 01

- [ ] Task
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(1);
			expect(docs[0].isUpdate).toBe(true);
		});
	});

	describe('splitIntoPhases', () => {
		it('should split content with phase headers', () => {
			const content = `
# Phase 1: Setup

- [ ] Task 1

# Phase 2: Build

- [ ] Task 2
`;

			const docs = splitIntoPhases(content);

			expect(docs).toHaveLength(2);
			expect(docs[0].phase).toBe(1);
			expect(docs[1].phase).toBe(2);
			expect(docs[0].isUpdate).toBe(false);
			expect(docs[1].isUpdate).toBe(false);
		});

		it('should treat content without phases as Phase 1', () => {
			const content = `
# Some Document

- [ ] Task 1
- [ ] Task 2
`;

			const docs = splitIntoPhases(content);

			expect(docs).toHaveLength(1);
			expect(docs[0].filename).toBe('Phase-01-Initial-Setup.md');
			expect(docs[0].phase).toBe(1);
			expect(docs[0].isUpdate).toBe(false);
		});

		it('should handle empty content', () => {
			const docs = splitIntoPhases('');
			expect(docs).toHaveLength(0);
		});

		it('should extract description from phase header', () => {
			const content = `
# Phase 1: Project Configuration

- [ ] Configure project

# Phase 2: Core Implementation

- [ ] Implement core
`;

			const docs = splitIntoPhases(content);

			expect(docs).toHaveLength(2);
			expect(docs[0].filename).toContain('Phase-01');
			expect(docs[0].filename).toContain('Project-Configuration');
			expect(docs[1].filename).toContain('Phase-02');
			expect(docs[1].filename).toContain('Core-Implementation');
		});
	});

	describe('sanitizeFilename', () => {
		it('should remove path separators', () => {
			expect(sanitizeFilename('path/to/file.md')).toBe('path-to-file.md');
			expect(sanitizeFilename('path\\to\\file.md')).toBe('path-to-file.md');
		});

		it('should remove directory traversal sequences', () => {
			// Path separators become dashes, .. is removed, leading dots are stripped
			expect(sanitizeFilename('../../../etc/passwd')).toBe('---etc-passwd');
			expect(sanitizeFilename('..file.md')).toBe('file.md');
		});

		it('should remove leading dots', () => {
			expect(sanitizeFilename('.hidden')).toBe('hidden');
			expect(sanitizeFilename('...file')).toBe('file');
		});

		it('should return "document" for empty result', () => {
			expect(sanitizeFilename('')).toBe('document');
			expect(sanitizeFilename('...')).toBe('document');
			// Forward slash becomes dash
			expect(sanitizeFilename('/')).toBe('-');
		});

		it('should trim whitespace', () => {
			expect(sanitizeFilename('  file.md  ')).toBe('file.md');
		});
	});

	describe('countTasks', () => {
		it('should count unchecked tasks', () => {
			const content = `
# Tasks

- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;
			expect(countTasks(content)).toBe(3);
		});

		it('should count checked tasks', () => {
			const content = `
# Tasks

- [x] Done task 1
- [X] Done task 2
`;
			expect(countTasks(content)).toBe(2);
		});

		it('should count mixed tasks', () => {
			const content = `
# Tasks

- [ ] Todo 1
- [x] Done 1
- [ ] Todo 2
- [X] Done 2
`;
			expect(countTasks(content)).toBe(4);
		});

		it('should return 0 for content without tasks', () => {
			const content = '# Just a heading\n\nSome text.';
			expect(countTasks(content)).toBe(0);
		});

		it('should handle empty content', () => {
			expect(countTasks('')).toBe(0);
		});
	});

	describe('generateWizardFolderBaseName', () => {
		it('should generate date-prefixed folder name with project name', () => {
			const result = generateWizardFolderBaseName('My Cool Project');

			// Should match YYYY-MM-DD-My-Cool-Project
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}-My-Cool-Project$/);
		});

		it('should fall back to Wizard suffix when no project name given', () => {
			const result = generateWizardFolderBaseName();

			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}-Wizard$/);
		});

		it('should fall back to Wizard suffix for empty/whitespace project name', () => {
			expect(generateWizardFolderBaseName('')).toMatch(/^\d{4}-\d{2}-\d{2}-Wizard$/);
			expect(generateWizardFolderBaseName('   ')).toMatch(/^\d{4}-\d{2}-\d{2}-Wizard$/);
		});

		it('should use current date', () => {
			const now = new Date();
			const year = now.getFullYear();
			const month = String(now.getMonth() + 1).padStart(2, '0');
			const day = String(now.getDate()).padStart(2, '0');
			const expected = `${year}-${month}-${day}-Wizard`;

			expect(generateWizardFolderBaseName()).toBe(expected);
		});

		it('should pad single-digit months and days with zeros', () => {
			const result = generateWizardFolderBaseName();

			// Extract date parts (YYYY-MM-DD-Name)
			const parts = result.split('-');
			const month = parts[1];
			const day = parts[2];

			// Should be exactly 2 digits
			expect(month).toHaveLength(2);
			expect(day).toHaveLength(2);
		});

		it('should sanitize special characters from project name', () => {
			const result = generateWizardFolderBaseName('my/project@v2!');
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}-Myprojectv2$/);
		});

		it('should convert spaces and hyphens to PascalCase-hyphenated', () => {
			const result = generateWizardFolderBaseName('worktree from autorun');
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}-Worktree-From-Autorun$/);
		});
	});

	describe('generateDocumentPrompt', () => {
		beforeAll(async () => {
			const fs = require('fs');
			const path = require('path');
			const promptsDir = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'prompts');
			(window as any).maestro = {
				...(window as any).maestro,
				prompts: {
					get: vi.fn((id: string) => {
						const filenameMap: Record<string, string> = {
							'wizard-document-generation': 'wizard-document-generation.md',
							'wizard-inline-iterate-generation': 'wizard-inline-iterate-generation.md',
						};
						const filename = filenameMap[id];
						if (!filename)
							return Promise.resolve({ success: false, error: `Unknown prompt: ${id}` });
						try {
							const content = fs.readFileSync(path.join(promptsDir, filename), 'utf-8');
							return Promise.resolve({ success: true, content });
						} catch (e: any) {
							return Promise.resolve({ success: false, error: e.message });
						}
					}),
				},
			};
			await loadInlineWizardDocGenPrompts(true);
		});

		// Helper to create a minimal config for testing
		const createTestConfig = (
			overrides: Partial<DocumentGenerationConfig> = {}
		): DocumentGenerationConfig => ({
			agentType: 'claude-code',
			directoryPath: '/project/root',
			projectName: 'Test Project',
			conversationHistory: [
				{ id: '1', role: 'user', content: 'Build a web app', timestamp: Date.now() },
				{ id: '2', role: 'assistant', content: 'I can help with that', timestamp: Date.now() },
			],
			mode: 'new',
			autoRunFolderPath: '/project/root/.maestro/playbooks',
			...overrides,
		});

		it('should use the configured autoRunFolderPath in the prompt', () => {
			const config = createTestConfig({
				autoRunFolderPath: '/custom/autorun/path',
			});

			const prompt = generateDocumentPrompt(config);

			// The prompt should contain the custom path, not the default '.maestro/playbooks'
			expect(prompt).toContain('/custom/autorun/path');
			// Should NOT contain the hardcoded pattern with directoryPath + default folder
			expect(prompt).not.toContain('/project/root/.maestro/playbooks');
		});

		it('should use external autoRunFolderPath when different from directoryPath', () => {
			const config = createTestConfig({
				directoryPath: '/main/repo',
				autoRunFolderPath: '/worktrees/autorun/feature-branch',
			});

			const prompt = generateDocumentPrompt(config);

			// The prompt should instruct writing to the external path
			expect(prompt).toContain('/worktrees/autorun/feature-branch');
			// Read access should still reference the project directory
			expect(prompt).toContain('/main/repo');
		});

		it('should append subfolder to autoRunFolderPath when provided', () => {
			const config = createTestConfig({
				autoRunFolderPath: '/custom/autorun',
			});

			const prompt = generateDocumentPrompt(config, 'Wizard-2026-01-11');

			// Should contain the full path with subfolder
			expect(prompt).toContain('/custom/autorun/Wizard-2026-01-11');
		});

		it('should handle autoRunFolderPath that is inside directoryPath', () => {
			const config = createTestConfig({
				directoryPath: '/project/root',
				autoRunFolderPath: '/project/root/.maestro/playbooks',
			});

			const prompt = generateDocumentPrompt(config);

			// Should still work correctly when path is inside project
			expect(prompt).toContain('/project/root/.maestro/playbooks');
		});

		it('should include project name in the prompt', () => {
			const config = createTestConfig({
				projectName: 'My Awesome Project',
			});

			const prompt = generateDocumentPrompt(config);

			expect(prompt).toContain('My Awesome Project');
		});

		it('should include conversation summary in the prompt', () => {
			const config = createTestConfig({
				conversationHistory: [
					{ id: '1', role: 'user', content: 'I want to build a dashboard', timestamp: Date.now() },
					{
						id: '2',
						role: 'assistant',
						content: 'What metrics should it display?',
						timestamp: Date.now(),
					},
				],
			});

			const prompt = generateDocumentPrompt(config);

			expect(prompt).toContain('User: I want to build a dashboard');
			expect(prompt).toContain('Assistant: What metrics should it display?');
		});

		it('should use iterate prompt template when mode is iterate', () => {
			const config = createTestConfig({
				mode: 'iterate',
				goal: 'Add authentication',
				existingDocuments: [
					{
						name: 'Phase-01-Setup',
						filename: 'Phase-01-Setup.md',
						path: '/path/Phase-01-Setup.md',
					},
				],
			});

			const prompt = generateDocumentPrompt(config);

			// Iterate mode has specific markers
			expect(prompt).toContain('Add authentication');
			expect(prompt).toContain('Existing Documents');
		});

		it('should NOT contain hardcoded .maestro/playbooks when custom path is configured', () => {
			const config = createTestConfig({
				directoryPath: '/my/project',
				autoRunFolderPath: '/completely/different/path',
			});

			const prompt = generateDocumentPrompt(config);

			// The combined pattern should be replaced with custom path
			// Check that we don't have the default path in write instructions
			expect(prompt).not.toMatch(/\/my\/project\/\.maestro\/playbooks/);
			expect(prompt).toContain('/completely/different/path');
		});

		it('should preserve directoryPath for read access instructions', () => {
			const config = createTestConfig({
				directoryPath: '/project/source',
				autoRunFolderPath: '/external/autorun',
			});

			const prompt = generateDocumentPrompt(config);

			// Read access should reference project directory
			expect(prompt).toContain('Read any file in: `/project/source`');
			// Write access should reference autorun path
			expect(prompt).toContain('/external/autorun');
		});
	});

	describe('createPlaybookDocumentEmitter', () => {
		const SUBFOLDER = '/playbooks/2026-05-15-Chat';

		// Per-test backing store for the mocked filesystem.
		let diskFiles: Map<string, string>;
		let onEmit: ReturnType<typeof vi.fn>;
		let readFileMock: ReturnType<typeof vi.fn>;
		let listDocsMock: ReturnType<typeof vi.fn>;
		let emitter: PlaybookDocumentEmitter;

		// Factory mirrors production's default retry budget but is overridable
		// per test so we can verify slow-read behavior without long sleeps.
		const makeEmitter = (
			retries: { maxAttempts: number; delayMs: number } = { maxAttempts: 3, delayMs: 1 }
		): PlaybookDocumentEmitter =>
			createPlaybookDocumentEmitter({
				subfolderPath: SUBFOLDER,
				onEmit: (doc) => onEmit(doc),
				readRetries: retries,
			});

		beforeEach(() => {
			diskFiles = new Map();
			onEmit = vi.fn();
			readFileMock = vi.fn((filePath: string) => {
				const content = diskFiles.get(filePath);
				if (content === undefined) {
					return Promise.reject(new Error(`ENOENT: ${filePath}`));
				}
				return Promise.resolve(content);
			});
			listDocsMock = vi.fn(() => {
				// listDocs returns filenames WITHOUT the .md extension, matching
				// the real IPC handler's behavior.
				const files = [...diskFiles.keys()]
					.filter((p) => p.startsWith(`${SUBFOLDER}/`))
					.map((p) => p.slice(SUBFOLDER.length + 1).replace(/\.md$/, ''));
				return Promise.resolve({ success: true, files });
			});

			(window as any).maestro = {
				...(window as any).maestro,
				fs: { readFile: readFileMock },
				autorun: {
					...((window as any).maestro?.autorun || {}),
					listDocs: listDocsMock,
				},
			};

			emitter = makeEmitter();
		});

		it('emits a doc the first time tryEmitFile sees a readable file', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '# Phase 01\n\n- [ ] one\n- [ ] two');

			const result = await emitter.tryEmitFile('Phase-01-Setup.md');

			expect(result).toBe(true);
			expect(onEmit).toHaveBeenCalledTimes(1);
			const doc = onEmit.mock.calls[0][0] as InlineGeneratedDocument;
			expect(doc.filename).toBe('Phase-01-Setup.md');
			expect(doc.taskCount).toBe(2);
			expect(doc.savedPath).toBe(`${SUBFOLDER}/Phase-01-Setup.md`);
		});

		it('re-appends .md when the watcher strips it', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-02-Build.md`, '# Phase 02\n- [ ] task');

			const result = await emitter.tryEmitFile('Phase-02-Build');

			expect(result).toBe(true);
			expect(onEmit.mock.calls[0][0].filename).toBe('Phase-02-Build.md');
		});

		it('skips a file that has already been emitted (dedup across calls)', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '# Phase 01');

			await emitter.tryEmitFile('Phase-01-Setup.md');
			const second = await emitter.tryEmitFile('Phase-01-Setup.md');

			expect(second).toBe(false);
			expect(onEmit).toHaveBeenCalledTimes(1);
		});

		it('retries through transient ENOENT then emits when the file lands', async () => {
			// Simulate the fsevents cold-start race: watcher fires before the
			// file is readable, but a later retry within the window succeeds.
			let attempts = 0;
			readFileMock.mockImplementation(() => {
				attempts++;
				if (attempts < 3) return Promise.reject(new Error('ENOENT'));
				return Promise.resolve('# Phase 01\n- [ ] task');
			});

			const result = await emitter.tryEmitFile('Phase-01-Setup.md', {
				maxAttempts: 5,
				delayMs: 1,
			});

			expect(result).toBe(true);
			expect(attempts).toBe(3);
			expect(onEmit).toHaveBeenCalledTimes(1);
		});

		it('returns false (without throwing) when retries run out', async () => {
			readFileMock.mockRejectedValue(new Error('ENOENT'));

			const result = await emitter.tryEmitFile('Missing.md', { maxAttempts: 2, delayMs: 1 });

			expect(result).toBe(false);
			expect(onEmit).not.toHaveBeenCalled();
		});

		it('does not emit an empty file (treats empty content as not-yet-flushed)', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '');

			const result = await emitter.tryEmitFile('Phase-01-Setup.md', {
				maxAttempts: 2,
				delayMs: 1,
			});

			expect(result).toBe(false);
			expect(onEmit).not.toHaveBeenCalled();
		});

		it('pollAndEmit surfaces every new file the watcher missed', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '# Phase 01\n- [ ] a');
			diskFiles.set(`${SUBFOLDER}/Phase-02-Build.md`, '# Phase 02\n- [ ] b');
			diskFiles.set(`${SUBFOLDER}/Phase-03-Ship.md`, '# Phase 03\n- [ ] c');

			const newCount = await emitter.pollAndEmit();

			expect(newCount).toBe(3);
			expect(onEmit).toHaveBeenCalledTimes(3);
			expect(
				emitter
					.getEmittedDocuments()
					.map((d) => d.filename)
					.sort()
			).toEqual(['Phase-01-Setup.md', 'Phase-02-Build.md', 'Phase-03-Ship.md']);
		});

		it('pollAndEmit dedupes against files already emitted via tryEmitFile', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '# Phase 01\n- [ ] a');
			diskFiles.set(`${SUBFOLDER}/Phase-02-Build.md`, '# Phase 02\n- [ ] b');

			// Watcher path emits Phase 01 first.
			await emitter.tryEmitFile('Phase-01-Setup.md');
			expect(onEmit).toHaveBeenCalledTimes(1);

			// Poll should pick up only Phase 02; Phase 01 is already known.
			const newCount = await emitter.pollAndEmit();
			expect(newCount).toBe(1);
			expect(onEmit).toHaveBeenCalledTimes(2);
			expect(onEmit.mock.calls[1][0].filename).toBe('Phase-02-Build.md');
		});

		it('pollAndEmit is safe to call repeatedly without re-emitting', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '# Phase 01\n- [ ] a');

			const first = await emitter.pollAndEmit();
			const second = await emitter.pollAndEmit();
			const third = await emitter.pollAndEmit();

			expect(first).toBe(1);
			expect(second).toBe(0);
			expect(third).toBe(0);
			expect(onEmit).toHaveBeenCalledTimes(1);
		});

		it('pollAndEmit picks up files added between ticks (steady state)', async () => {
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '# Phase 01\n- [ ] a');

			await emitter.pollAndEmit();
			expect(onEmit).toHaveBeenCalledTimes(1);

			// Agent writes the next phase between polls.
			diskFiles.set(`${SUBFOLDER}/Phase-02-Build.md`, '# Phase 02\n- [ ] b');

			const newCount = await emitter.pollAndEmit();
			expect(newCount).toBe(1);
			expect(onEmit).toHaveBeenCalledTimes(2);
			expect(onEmit.mock.calls[1][0].filename).toBe('Phase-02-Build.md');
		});

		it('pollAndEmit tolerates listDocs failure without throwing', async () => {
			listDocsMock.mockResolvedValueOnce({ success: false, error: 'permission denied' });

			const newCount = await emitter.pollAndEmit();
			expect(newCount).toBe(0);
			expect(onEmit).not.toHaveBeenCalled();
		});

		it('counts taskCount correctly on emitted documents', async () => {
			diskFiles.set(
				`${SUBFOLDER}/Phase-01-Setup.md`,
				'# Phase 01\n\n- [ ] task one\n- [ ] task two\n- [x] task three already done\n'
			);

			await emitter.tryEmitFile('Phase-01-Setup.md');

			expect(onEmit.mock.calls[0][0].taskCount).toBe(3);
		});

		it('hasEmitted flips to true after the first emission', async () => {
			expect(emitter.hasEmitted()).toBe(false);
			diskFiles.set(`${SUBFOLDER}/Phase-01-Setup.md`, '# Phase 01');
			await emitter.tryEmitFile('Phase-01-Setup.md');
			expect(emitter.hasEmitted()).toBe(true);
		});
	});
	describe('Grok complete generation', () => {
		const document =
			'---BEGIN DOCUMENT---\nFILENAME: Phase-01-Setup.md\nCONTENT:\n- [ ] Build it\n---END DOCUMENT---';
		let onComplete: ReturnType<typeof vi.fn>;
		let onDocumentComplete: ReturnType<typeof vi.fn>;
		let onError: ReturnType<typeof vi.fn>;
		let removeListener: ReturnType<typeof vi.fn>;
		let config: DocumentGenerationConfig;

		beforeEach(() => {
			onComplete = vi.fn();
			onDocumentComplete = vi.fn();
			onError = vi.fn();
			removeListener = vi.fn();
			window.maestro.agents.get = vi
				.fn()
				.mockImplementation(async (id: string) => ({ id, available: true, command: id, args: [] }));
			Object.assign(window.maestro.process, {
				spawn: vi.fn().mockResolvedValue({ pid: 123, success: true }),
				onData: vi.fn(() => vi.fn(() => removeListener())),
				onExit: vi.fn(() => vi.fn(() => removeListener())),
				onAgentError: vi.fn(() => vi.fn(() => removeListener())),
				kill: vi.fn().mockResolvedValue(true),
			});
			Object.assign(window.maestro.autorun, {
				listDocs: vi.fn().mockResolvedValue({ success: true, files: [], tree: [] }),
				watchFolder: vi.fn().mockResolvedValue({ success: true }),
				unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
				onFileChanged: vi.fn(() => vi.fn(() => removeListener())),
				writeDoc: vi.fn().mockResolvedValue({ success: true }),
			});
		});

		beforeEach(() => {
			window.maestro.playbooks.create = vi.fn().mockResolvedValue({
				success: true,
				playbook: { id: 'playbook-1', name: 'Plan' },
			});
			config = {
				agentType: 'grok',
				directoryPath: '/project',
				projectName: 'Plan',
				conversationHistory: [],
				mode: 'new',
				autoRunFolderPath: '/playbooks',
				sessionId: 'owner-agent',
				callbacks: {
					onStart: vi.fn(),
					onProgress: vi.fn(),
					onChunk: vi.fn(),
					onComplete,
					onDocumentComplete,
					onError,
				},
			};
		});

		async function start(signal?: AbortSignal) {
			const pending = generateInlineDocuments({ ...config, signal });
			if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
			else await vi.waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalledOnce());
			expect(window.maestro.process.spawn).toHaveBeenCalledOnce();
			return {
				pending,
				id: vi.mocked(window.maestro.process.spawn).mock.calls[0][0].sessionId,
				data: vi.mocked(window.maestro.process.onData).mock.calls[0][0],
				exit: vi.mocked(window.maestro.process.onExit).mock.calls[0][0],
				folder: vi.mocked(window.maestro.autorun.watchFolder).mock.calls[0][0],
			};
		}

		it.each(['normalized', 'native'])(
			'saves the entire %s answer and only then completes',
			async (transport) => {
				const content = '- [ ] Begin\n' + 'Details\n'.repeat(4000) + '- [ ] Final task';
				const output = document.replace('- [ ] Build it', content);
				const { pending, id, data, exit } = await start();
				expect(window.maestro.process.spawn).toHaveBeenCalledWith(
					expect.objectContaining({
						toolType: 'grok',
						permissionMode: 'full',
						args: ['--max-turns', '32', '--no-subagents'],
					})
				);
				data('other-process', document);
				if (transport === 'native') {
					for (const event of [
						{ type: 'thought', data: document.replace('Build it', 'Never save thinking') },
						{
							type: 'tool_call',
							toolCallId: 'read-1',
							toolName: 'read_file',
							rawInput: { text: document },
						},
						{ type: 'text', data: output },
						{ type: 'end', stopReason: 'EndTurn', sessionId: 'native-id' },
					])
						data(id, JSON.stringify(event) + '\n');
				} else {
					data(id, output.slice(0, 30));
					data(id, output.slice(30));
				}
				expect(onDocumentComplete).not.toHaveBeenCalled();
				expect(onComplete).not.toHaveBeenCalled();
				exit(id, 0);
				const result = await pending;
				expect(result.success).toBe(true);
				expect(result.documents).toEqual([expect.objectContaining({ content, taskCount: 2 })]);
				expect(window.maestro.autorun.writeDoc).toHaveBeenCalledExactlyOnceWith(
					expect.any(String),
					'Phase-01-Setup.md',
					content,
					undefined
				);
				expect(onDocumentComplete).toHaveBeenCalledOnce();
				expect(onComplete).toHaveBeenCalledExactlyOnceWith(result.documents);
				expect(onError).not.toHaveBeenCalled();
			}
		);

		it.each([
			['absent', ''],
			['unstructured', '- [ ] Not a complete document'],
			['truncated tail', document + '\n---BEGIN DOCUMENT---\nFILENAME: Phase-02.md'],
			['missing filename', document.replace('FILENAME: Phase-01-Setup.md\n', '')],
			['missing content', document.replace('CONTENT:\n', '')],
			[
				'end before content',
				document
					.replace('CONTENT:\n', '---END DOCUMENT---\nCONTENT:\n')
					.replace(/---END DOCUMENT---$/, ''),
			],
			['task-free', document.replace('- [ ] Build it', '# Notes')],
			['duplicate', document + '\n' + document],
			['unsafe name', document.replace('Phase-01-Setup.md', '../Phase-01.md')],
			[
				'thinking only',
				JSON.stringify({ type: 'thought', data: document }) +
					'\n' +
					JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
			],
		])('refuses %s without saving a partial plan', async (_case, output) => {
			const { pending, id, data, exit } = await start();
			data(id, output);
			exit(id, 0);
			expect(await pending).toMatchObject({ success: false, error: expect.any(String) });
			expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
			expect(onDocumentComplete).not.toHaveBeenCalled();
			expect(onComplete).not.toHaveBeenCalled();
			expect(onError).toHaveBeenCalledOnce();
		});

		it.each(['abort', 'signal', 'denial', 'spawn-refusal'])(
			'does not complete streamed documents after %s',
			async (failure) => {
				if (failure === 'spawn-refusal')
					vi.mocked(window.maestro.process.spawn).mockResolvedValue({ pid: -1, success: false });
				const controller = new AbortController();
				const { pending, id, data, exit } = await start(controller.signal);
				data(id, document);
				if (failure === 'abort') controller.abort();
				if (failure === 'denial')
					vi.mocked(window.maestro.process.onAgentError).mock.calls[0][0](id, {
						type: 'permission_denied',
						message: 'Managed generation refused',
						recoverable: false,
						agentId: 'grok',
						timestamp: 1,
					});
				exit(id, 0, failure === 'signal' ? 15 : undefined);
				expect(await pending).toMatchObject({ success: false, error: expect.any(String) });
				data(id, document);
				exit(id, 0);
				expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
				expect(onComplete).not.toHaveBeenCalled();
				expect(onDocumentComplete).not.toHaveBeenCalled();
				expect(removeListener).toHaveBeenCalled();
				if (failure === 'abort') expect(window.maestro.process.kill).toHaveBeenCalledWith(id);
			}
		);

		it.each(['listing', 'second-save'])(
			'refuses %s failure instead of reporting partial success',
			async (failure) => {
				const { pending, id, data, exit } = await start();
				if (failure === 'listing')
					vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
						success: false,
						error: 'Unreadable',
					});
				else
					vi.mocked(window.maestro.autorun.writeDoc)
						.mockResolvedValueOnce({ success: true })
						.mockResolvedValueOnce({ success: false, error: 'Write refused' });
				data(id, document + '\n' + document.replace('Phase-01-Setup.md', 'Phase-02-Build.md'));
				exit(id, 0);
				expect(await pending).toMatchObject({ success: false, error: expect.any(String) });
				expect(onComplete).not.toHaveBeenCalled();
				expect(onDocumentComplete).not.toHaveBeenCalled();
				expect(window.maestro.autorun.writeDoc).toHaveBeenCalledTimes(
					failure === 'listing' ? 0 : 2
				);
			}
		);
		it.each(['disk', 'mixed', 'conflict', 'read-failure'])(
			'validates final disk documents for %s output',
			async (mode) => {
				const { pending, id, data, exit } = await start();
				vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
					success: true,
					files: ['Phase-02-Build'],
				});
				window.maestro.fs.readFile = vi.fn().mockResolvedValue('- [ ] In-progress');
				window.maestro.autorun.readDoc = vi
					.fn()
					.mockResolvedValue(
						mode === 'read-failure'
							? { success: false, error: 'Unreadable' }
							: { success: true, content: '- [ ] Final disk task' }
					);
				const folderPath = vi.mocked(window.maestro.autorun.watchFolder).mock.calls[0][0];
				vi.mocked(window.maestro.autorun.onFileChanged).mock.calls[0][0]({
					folderPath,
					filename: 'Phase-02-Build.md',
					eventType: 'change',
				});
				await vi.waitFor(() => expect(window.maestro.fs.readFile).toHaveBeenCalled());
				expect(onDocumentComplete).not.toHaveBeenCalled();
				if (mode === 'mixed') data(id, document);
				if (mode === 'conflict')
					data(id, document.replace('Phase-01-Setup.md', 'Phase-02-Build.md'));
				exit(id, 0);
				const result = await pending;
				expect(result.success).toBe(mode === 'disk' || mode === 'mixed');
				if (result.success) {
					expect(result.documents?.map((doc) => doc.content)).toEqual(
						mode === 'mixed'
							? ['- [ ] Build it', '- [ ] Final disk task']
							: ['- [ ] Final disk task']
					);
					expect(onComplete).toHaveBeenCalledExactlyOnceWith(result.documents);
				} else {
					expect(onComplete).not.toHaveBeenCalled();
					expect(onDocumentComplete).not.toHaveBeenCalled();
					expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
				}
			}
		);
		describe('cancellation and inactivity boundaries', () => {
			beforeEach(() => {
				vi.useFakeTimers();
			});

			afterEach(() => {
				vi.clearAllTimers();
				vi.useRealTimers();
				vi.restoreAllMocks();
			});

			it.each(['grok', 'claude-code', 'codex'] as const)(
				'refuses a pre-aborted %s generation before preparation',
				async (agentType) => {
					const controller = new AbortController();
					controller.abort();
					expect(
						await generateInlineDocuments({ ...config, agentType, signal: controller.signal })
					).toEqual({ success: false, error: 'Document generation was cancelled.' });
					for (const callback of Object.values(config.callbacks!))
						expect(callback).not.toHaveBeenCalled();
					for (const operation of [
						window.maestro.agents.get,
						window.maestro.autorun.listDocs,
						window.maestro.process.spawn,
						window.maestro.process.kill,
						window.maestro.process.onData,
						window.maestro.process.onExit,
						window.maestro.process.onAgentError,
						window.maestro.autorun.watchFolder,
						window.maestro.autorun.writeDoc,
						window.maestro.playbooks.create,
					])
						expect(operation).not.toHaveBeenCalled();
					expect(vi.getTimerCount()).toBe(0);
				}
			);

			it.each(['grok', 'claude-code', 'codex'] as const)(
				'does not launch %s when cancelled during provider lookup',
				async (agentType) => {
					const preparation =
						Promise.withResolvers<Awaited<ReturnType<typeof window.maestro.agents.get>>>();
					vi.mocked(window.maestro.agents.get).mockReturnValueOnce(preparation.promise);
					const controller = new AbortController();
					const pending = generateInlineDocuments({
						...config,
						agentType,
						signal: controller.signal,
					});
					await vi.advanceTimersByTimeAsync(0);
					expect(window.maestro.agents.get).toHaveBeenCalledExactlyOnceWith(agentType);
					controller.abort();
					preparation.resolve({
						id: agentType,
						name: agentType,
						available: true,
						command: agentType,
						args: [],
					});
					expect(await pending).toMatchObject({
						success: false,
						error: 'Document generation was cancelled.',
					});
					expect(window.maestro.process.spawn).not.toHaveBeenCalled();
					expect(window.maestro.autorun.watchFolder).not.toHaveBeenCalled();
					expect(window.maestro.process.onData).not.toHaveBeenCalled();
					expect(window.maestro.process.onExit).not.toHaveBeenCalled();
					expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
					expect(window.maestro.playbooks.create).not.toHaveBeenCalled();
					expect(onComplete).not.toHaveBeenCalled();
					expect(onDocumentComplete).not.toHaveBeenCalled();
					expect(onError).toHaveBeenCalledOnce();
					expect(window.maestro.process.kill).toHaveBeenCalledExactlyOnceWith(
						expect.stringMatching(/^inline-wizard-gen-/)
					);
					expect(vi.getTimerCount()).toBe(0);
				}
			);

			it.each(['final disk read', 'final emitter sweep'])(
				'discards documents when aborted during the %s',
				async (boundary) => {
					const read = Promise.withResolvers<{ success: boolean; content: string }>();
					const sweep = Promise.withResolvers<string>();
					const controller = new AbortController();
					const { pending, id, data, exit } = await start(controller.signal);
					vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
						success: true,
						files: ['Phase-01-Setup'],
					});
					window.maestro.autorun.readDoc = vi
						.fn()
						.mockReturnValue(
							boundary === 'final disk read'
								? read.promise
								: Promise.resolve({ success: true, content: '- [ ] Build it' })
						);
					window.maestro.fs.readFile = vi.fn().mockReturnValue(sweep.promise);
					exit(id, 0);
					await vi.advanceTimersByTimeAsync(0);
					expect(window.maestro.autorun.readDoc).toHaveBeenCalledOnce();
					if (boundary === 'final emitter sweep')
						expect(window.maestro.fs.readFile).toHaveBeenCalledOnce();
					controller.abort();
					read.resolve({ success: true, content: '- [ ] Build it' });
					sweep.resolve('- [ ] Build it');
					expect(await pending).toMatchObject({ success: false, error: expect.any(String) });
					data(id, document);
					exit(id, 0);
					expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
					expect(window.maestro.playbooks.create).not.toHaveBeenCalled();
					expect(onComplete).not.toHaveBeenCalled();
					expect(onDocumentComplete).not.toHaveBeenCalled();
					expect(onError).toHaveBeenCalledOnce();
					// The process already exited before cancellation reached disk I/O.
					expect(window.maestro.process.kill).not.toHaveBeenCalled();
					expect(removeListener).toHaveBeenCalledTimes(4);
					expect(vi.getTimerCount()).toBe(0);
				}
			);

			it.each(['grok', 'claude-code', 'codex'] as const)(
				'stops %s after an in-flight write without saving the next document',
				async (agentType) => {
					config.agentType = agentType;
					const write = Promise.withResolvers<{ success: boolean }>();
					vi.mocked(window.maestro.autorun.writeDoc).mockReturnValueOnce(write.promise);
					const controller = new AbortController();
					const { pending, id, data, exit, folder } = await start(controller.signal);
					data(id, document + '\n' + document.replace('Phase-01-Setup.md', 'Phase-02-Build.md'));
					exit(id, 0);
					await vi.advanceTimersByTimeAsync(0);
					expect(window.maestro.autorun.writeDoc).toHaveBeenCalledExactlyOnceWith(
						folder,
						'Phase-01-Setup.md',
						'- [ ] Build it',
						undefined
					);
					controller.abort();
					// An already-started write may land; cancellation prevents the next one.
					write.resolve({ success: true });
					expect(await pending).toMatchObject({ success: false, error: expect.any(String) });
					expect(window.maestro.autorun.writeDoc).toHaveBeenCalledOnce();
					expect(window.maestro.playbooks.create).not.toHaveBeenCalled();
					expect(onComplete).not.toHaveBeenCalled();
					expect(onDocumentComplete).not.toHaveBeenCalled();
					expect(onError).toHaveBeenCalledOnce();
					expect(window.maestro.process.kill).not.toHaveBeenCalled();
					expect(vi.getTimerCount()).toBe(0);
				}
			);

			it.each(['abort', 'timeout'])(
				'stops only the owned process when a pending spawn resolves after %s',
				async (reason) => {
					const spawn =
						Promise.withResolvers<Awaited<ReturnType<typeof window.maestro.process.spawn>>>();
					vi.mocked(window.maestro.process.spawn).mockReturnValueOnce(spawn.promise);
					const controller = new AbortController();
					const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
					const { pending, id, data, exit, folder } = await start(controller.signal);
					const settled = vi.fn();
					void pending.then(settled);
					data('unrelated-process', document);
					exit('unrelated-process', 0);
					if (reason === 'abort') controller.abort();
					else {
						await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
						expect(settled).not.toHaveBeenCalled();
						expect(window.maestro.process.kill).not.toHaveBeenCalled();
						await vi.advanceTimersByTimeAsync(1);
					}
					expect(await pending).toMatchObject({
						success: false,
						error:
							reason === 'abort'
								? 'Document generation was cancelled.'
								: expect.stringContaining('20 minutes'),
					});
					expect(window.maestro.process.kill).toHaveBeenCalledExactlyOnceWith(id);
					for (const registration of [
						window.maestro.process.onData,
						window.maestro.process.onExit,
						window.maestro.process.onAgentError,
						window.maestro.autorun.onFileChanged,
					])
						expect(vi.mocked(registration).mock.results[0].value).toHaveBeenCalledOnce();
					expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
					expect(window.maestro.autorun.unwatchFolder).toHaveBeenCalledExactlyOnceWith(folder);
					expect(vi.getTimerCount()).toBe(0);
					spawn.resolve({ pid: 123, success: true });
					await vi.advanceTimersByTimeAsync(0);
					expect(vi.mocked(window.maestro.process.kill).mock.calls).toEqual([[id], [id]]);
					data(id, document);
					exit(id, 0);
					const polls = vi.mocked(window.maestro.autorun.listDocs).mock.calls.length;
					await vi.advanceTimersByTimeAsync(20 * 60_000);
					expect(window.maestro.autorun.listDocs).toHaveBeenCalledTimes(polls);
					expect(vi.getTimerCount()).toBe(0);
					expect(settled).toHaveBeenCalledOnce();
					expect(config.callbacks!.onChunk).not.toHaveBeenCalled();
					expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
					expect(window.maestro.playbooks.create).not.toHaveBeenCalled();
					expect(onComplete).not.toHaveBeenCalled();
					expect(onDocumentComplete).not.toHaveBeenCalled();
					expect(onError).toHaveBeenCalledOnce();
				}
			);

			it('unwatches a folder whose watcher setup resolves after cancellation', async () => {
				const watch = Promise.withResolvers<{ success: boolean }>();
				vi.mocked(window.maestro.autorun.watchFolder).mockReturnValueOnce(watch.promise);
				const controller = new AbortController();
				const { pending, id, folder } = await start(controller.signal);
				controller.abort();
				expect(await pending).toMatchObject({ success: false });
				expect(window.maestro.autorun.unwatchFolder).toHaveBeenCalledExactlyOnceWith(folder);
				watch.resolve({ success: true });
				await vi.advanceTimersByTimeAsync(0);
				expect(vi.mocked(window.maestro.autorun.unwatchFolder).mock.calls).toEqual([
					[folder],
					[folder],
				]);
				expect(window.maestro.autorun.onFileChanged).not.toHaveBeenCalled();
				expect(window.maestro.process.kill).toHaveBeenCalledExactlyOnceWith(id);
				expect(removeListener).toHaveBeenCalledTimes(3);
				expect(vi.getTimerCount()).toBe(0);
				expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
				expect(window.maestro.playbooks.create).not.toHaveBeenCalled();
				expect(onComplete).not.toHaveBeenCalled();
				expect(onDocumentComplete).not.toHaveBeenCalled();
			});

			it.each(['process output', 'folder activity'])(
				'resets the 20-minute inactivity window only for owned %s',
				async (activity) => {
					window.maestro.fs.readFile = vi.fn().mockResolvedValue('- [ ] Preview');
					const { pending, id, data, exit, folder } = await start();
					const changed = vi.mocked(window.maestro.autorun.onFileChanged).mock.calls[0][0];
					await vi.advanceTimersByTimeAsync(19 * 60_000);
					if (activity === 'process output') data(id, 'Working...');
					else changed({ folderPath: folder, filename: 'Phase-01-Setup.md', eventType: 'change' });
					await vi.advanceTimersByTimeAsync(19 * 60_000);
					expect(window.maestro.process.kill).not.toHaveBeenCalled();
					expect(onError).not.toHaveBeenCalled();
					data('unrelated-process', 'Still working');
					changed({
						folderPath: '/another-playbook',
						filename: 'Phase-02.md',
						eventType: 'change',
					});
					await vi.advanceTimersByTimeAsync(60_000 - 1);
					expect(window.maestro.process.kill).not.toHaveBeenCalled();
					await vi.advanceTimersByTimeAsync(1);
					expect(await pending).toMatchObject({
						success: false,
						error: expect.stringContaining('20 minutes of inactivity'),
					});
					expect(window.maestro.process.kill).toHaveBeenCalledExactlyOnceWith(id);
					expect(removeListener).toHaveBeenCalledTimes(4);
					expect(window.maestro.autorun.unwatchFolder).toHaveBeenCalledExactlyOnceWith(folder);
					data(id, document);
					exit(id, 0);
					expect(config.callbacks!.onChunk).toHaveBeenCalledTimes(
						activity === 'process output' ? 1 : 0
					);
					expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
					expect(window.maestro.playbooks.create).not.toHaveBeenCalled();
					expect(onComplete).not.toHaveBeenCalled();
					expect(onDocumentComplete).not.toHaveBeenCalled();
					expect(onError).toHaveBeenCalledOnce();
					expect(vi.getTimerCount()).toBe(0);
				}
			);
		});
	});
});
