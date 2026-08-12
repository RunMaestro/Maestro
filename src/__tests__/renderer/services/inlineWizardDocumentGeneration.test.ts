/**
 * Tests for inlineWizardDocumentGeneration.ts
 *
 * These tests verify the document parsing and iterate mode functionality.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
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
});
