/**
 * Tests for inlineWizardDocumentGeneration.ts
 *
 * These tests verify the document parsing and iterate mode functionality.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	extractDisplayTextFromChunk,
	generateInlineDocuments,
	parseGeneratedDocuments,
	splitIntoPhases,
	sanitizeFilename,
	generateWizardFolderBaseName,
	countTasks,
	generateDocumentPrompt,
	type DocumentGenerationConfig,
} from '../../../renderer/services/inlineWizardDocumentGeneration';

type GeneratedWindowMaestro = {
	agents: {
		get: ReturnType<typeof vi.fn>;
	};
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
	fs: {
		readFile: ReturnType<typeof vi.fn>;
	};
	playbooks: {
		create: ReturnType<typeof vi.fn>;
	};
};

describe('inlineWizardDocumentGeneration', () => {
	describe('extractDisplayTextFromChunk', () => {
		it('extracts Claude streaming deltas and assistant text blocks', () => {
			const chunk = [
				JSON.stringify({ type: 'content_block_delta', delta: { text: 'Hello ' } }),
				JSON.stringify({
					type: 'assistant',
					message: { content: [{ type: 'text', text: 'world' }, { type: 'tool_use' }] },
				}),
				'not-json',
			].join('\n');

			expect(extractDisplayTextFromChunk(chunk, 'claude-code')).toBe('Hello world');
		});

		it('extracts OpenCode text parts and ignores unrelated chunks', () => {
			const chunk = [
				JSON.stringify({ type: 'text', part: { text: 'Open' } }),
				JSON.stringify({ type: 'event', part: { text: 'ignored' } }),
				JSON.stringify({ type: 'text', part: { text: 'Code' } }),
			].join('\n');

			expect(extractDisplayTextFromChunk(chunk, 'opencode')).toBe('OpenCode');
		});

		it('extracts Codex agent messages and plain message text', () => {
			const chunk = [
				JSON.stringify({
					type: 'agent_message',
					content: [
						{ type: 'text', text: 'Agent ' },
						{ type: 'image', text: 'ignored' },
					],
				}),
				JSON.stringify({ type: 'message', text: 'message' }),
			].join('\n');

			expect(extractDisplayTextFromChunk(chunk, 'codex')).toBe('Agent message');
		});

		it('returns empty text for blank, malformed, or unsupported chunks', () => {
			expect(extractDisplayTextFromChunk('\n  \nnot-json', 'claude-code')).toBe('');
			expect(extractDisplayTextFromChunk(JSON.stringify({ type: 'text' }), 'opencode')).toBe('');
			expect(
				extractDisplayTextFromChunk(
					JSON.stringify({ type: 'content_block_delta', delta: {} }),
					'claude-code'
				)
			).toBe('');
			expect(
				extractDisplayTextFromChunk(
					JSON.stringify({ type: 'text', part: { text: 'ignored' } }),
					'gemini-cli'
				)
			).toBe('');
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

		it('should skip blocks missing filename, content marker, or non-empty content', () => {
			const output = `
---BEGIN DOCUMENT---
CONTENT:
# Missing filename
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-02-Missing-Content.md
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-03-Empty.md
CONTENT:

---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-04-Valid.md
CONTENT:
# Valid
- [ ] Task
---END DOCUMENT---
`;

			const docs = parseGeneratedDocuments(output);

			expect(docs).toHaveLength(1);
			expect(docs[0].filename).toBe('Phase-04-Valid.md');
		});

		it('should strip a trailing end marker from content when no lookahead consumed it', () => {
			const docs = parseGeneratedDocuments(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task
---END DOCUMENT---
`);

			expect(docs[0].content).toBe('# Test\n- [ ] Task');
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

		it('should support h2 phase headers and sanitize generated filenames', () => {
			const docs = splitIntoPhases(`
## Phase 1 - API & Auth!!!

- [ ] Build auth

## Phase 2

- [ ] Ship
`);

			expect(docs.map((doc) => doc.filename)).toEqual([
				'Phase-01-API-Auth.md',
				'Phase-02-Tasks.md',
			]);
			expect(docs[0].content).toContain('## Phase 1 - API & Auth!!!');
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

		it('should remove null bytes and control characters', () => {
			expect(sanitizeFilename('bad\x00\n\tname.md')).toBe('badname.md');
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
			autoRunFolderPath: '/project/root/Auto Run Docs',
			...overrides,
		});

		it('should use the configured autoRunFolderPath in the prompt', () => {
			const config = createTestConfig({
				autoRunFolderPath: '/custom/autorun/path',
			});

			const prompt = generateDocumentPrompt(config);

			// The prompt should contain the custom path, not the default 'Auto Run Docs'
			expect(prompt).toContain('/custom/autorun/path');
			// Should NOT contain the hardcoded pattern with directoryPath + default folder
			expect(prompt).not.toContain('/project/root/Auto Run Docs');
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
				autoRunFolderPath: '/project/root/Auto Run Docs',
			});

			const prompt = generateDocumentPrompt(config);

			// Should still work correctly when path is inside project
			expect(prompt).toContain('/project/root/Auto Run Docs');
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

		it('should include existing document content and iterate fallback goal', () => {
			const config = createTestConfig({
				mode: 'iterate',
				goal: undefined,
				existingDocuments: [
					{
						name: 'Phase-01-Setup',
						filename: 'Phase-01-Setup.md',
						path: '/path/Phase-01-Setup.md',
						content: '# Existing setup',
					},
				],
			});

			const prompt = generateDocumentPrompt(config);

			expect(prompt).toContain('### 1. Phase-01-Setup.md');
			expect(prompt).toContain('# Existing setup');
			expect(prompt).toContain('(No specific goal provided)');
		});

		it('should include fallback text for iterate mode with no existing documents', () => {
			const prompt = generateDocumentPrompt(
				createTestConfig({
					mode: 'iterate',
					existingDocuments: [],
				})
			);

			expect(prompt).toContain('(No existing documents found)');
		});

		it('should use iterate fallbacks when existingDocuments and goal are omitted', () => {
			const prompt = generateDocumentPrompt(createTestConfig({ mode: 'iterate' }));

			expect(prompt).toContain('(No existing documents found)');
			expect(prompt).toContain('(No specific goal provided)');
		});

		it('should omit non-conversation roles from the summary and use fallback project name', () => {
			const prompt = generateDocumentPrompt(
				createTestConfig({
					projectName: '',
					conversationHistory: [
						{ id: '1', role: 'system', content: 'Hidden instruction', timestamp: Date.now() },
						{ id: '2', role: 'user', content: 'Visible request', timestamp: Date.now() },
					],
				})
			);

			expect(prompt).toContain('this project');
			expect(prompt).toContain('User: Visible request');
			expect(prompt).not.toContain('Hidden instruction');
		});

		it('should NOT contain hardcoded Auto Run Docs when custom path is configured', () => {
			const config = createTestConfig({
				directoryPath: '/my/project',
				autoRunFolderPath: '/completely/different/path',
			});

			const prompt = generateDocumentPrompt(config);

			// The combined pattern should be replaced with custom path
			// Check that we don't have the default path in write instructions
			expect(prompt).not.toMatch(/\/my\/project\/Auto Run Docs/);
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

	describe('generateInlineDocuments', () => {
		let mockMaestro: GeneratedWindowMaestro;
		let capturedDataCallback: ((sessionId: string, data: string) => void) | undefined;
		let capturedExitCallback: ((sessionId: string, code: number) => void) | undefined;
		let capturedFileChangedCallback:
			| ((data: { filename?: string; eventType: string; folderPath: string }) => void)
			| undefined;
		let consoleError: ReturnType<typeof vi.spyOn>;
		let consoleLog: ReturnType<typeof vi.spyOn>;
		let consoleWarn: ReturnType<typeof vi.spyOn>;

		const createConfig = (
			overrides: Partial<DocumentGenerationConfig> = {}
		): DocumentGenerationConfig => ({
			agentType: 'opencode',
			directoryPath: '/repo',
			projectName: 'Coverage Project',
			conversationHistory: [{ id: '1', role: 'user', content: 'Build phases', timestamp: 1 }],
			mode: 'new',
			autoRunFolderPath: '/repo/Auto Run Docs',
			...overrides,
		});

		function installMaestro(): void {
			capturedDataCallback = undefined;
			capturedExitCallback = undefined;
			capturedFileChangedCallback = undefined;
			mockMaestro = {
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
			};

			vi.stubGlobal('window', { maestro: mockMaestro });
		}

		function completeSpawnWithOutput(output: string, exitCode = 0): void {
			mockMaestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
				setTimeout(() => {
					capturedDataCallback?.(sessionId, output);
				}, 0);
				setTimeout(() => {
					capturedExitCallback?.(sessionId, exitCode);
				}, 5);
			});
		}

		beforeEach(() => {
			installMaestro();
			consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});

		it('returns an error and skips spawn when a local agent is unavailable', async () => {
			mockMaestro.agents.get.mockResolvedValue({ id: 'opencode', available: false });
			const onError = vi.fn();

			const result = await generateInlineDocuments(createConfig({ callbacks: { onError } }));

			expect(result).toEqual({
				success: false,
				error: 'Agent opencode is not available',
			});
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
			expect(onError).toHaveBeenCalledWith('Agent opencode is not available');
			expect(consoleError).toHaveBeenCalledWith('[InlineWizardDocGen] Error:', expect.any(Error));
		});

		it('returns an error and skips spawn when no local agent is configured', async () => {
			mockMaestro.agents.get.mockResolvedValue(null);

			const result = await generateInlineDocuments(createConfig());

			expect(result).toEqual({
				success: false,
				error: 'Agent opencode is not available',
			});
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('allows remote generation to spawn even when no local agent is configured', async () => {
			mockMaestro.agents.get.mockResolvedValue(null);
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
			expect(mockMaestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'opencode',
					args: [],
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				})
			);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.stringContaining('/repo/Auto Run Docs'),
				'Phase-01-Remote.md',
				expect.stringContaining('# Remote'),
				'remote-1'
			);
			expect(consoleError).not.toHaveBeenCalled();
		});

		it('returns spawn failures without trying to parse or save documents', async () => {
			mockMaestro.process.spawn.mockRejectedValue(new Error('spawn failed'));
			const onError = vi.fn();

			const result = await generateInlineDocuments(createConfig({ callbacks: { onError } }));

			expect(result).toMatchObject({
				success: false,
				error: 'Failed to spawn agent: spawn failed',
				rawOutput: '',
			});
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
			expect(onError).toHaveBeenCalledWith('Failed to spawn agent: spawn failed');
		});

		it('returns process exit failures with streamed raw output', async () => {
			completeSpawnWithOutput('partial output', 2);
			const onChunk = vi.fn();
			const onError = vi.fn();

			const result = await generateInlineDocuments(
				createConfig({ callbacks: { onChunk, onError } })
			);

			expect(result).toMatchObject({
				success: false,
				error: 'Agent exited with code 2',
				rawOutput: 'partial output',
			});
			expect(onChunk).toHaveBeenCalledWith('partial output');
			expect(onError).toHaveBeenCalledWith('Agent exited with code 2');
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('parses stream-json output, saves documents, emits callbacks, and creates a playbook', async () => {
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
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledTimes(2);
			expect(mockMaestro.playbooks.create).toHaveBeenCalledWith('session-1', {
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

		it('chooses a numeric subfolder suffix when the generated folder already exists', async () => {
			const baseName = generateWizardFolderBaseName('Coverage Project');
			mockMaestro.autorun.listDocs.mockResolvedValue({
				success: true,
				tree: [{ name: baseName }, { name: `${baseName}-2` }, null, 'not-a-folder-entry'],
			});
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task
---END DOCUMENT---
`);

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(result.subfolderName).toBe(`${baseName}-3`);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				`/repo/Auto Run Docs/${baseName}-3`,
				'Phase-01-Test.md',
				expect.stringContaining('# Test'),
				undefined
			);
		});

		it('uses the base subfolder name when existing folder listing fails', async () => {
			const baseName = generateWizardFolderBaseName('Coverage Project');
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: false });
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task
---END DOCUMENT---
`);

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(result.subfolderName).toBe(baseName);
		});

		it('builds Claude args and parses Claude result stream output', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'claude-code',
				available: true,
				path: '/bin/claude',
				args: [],
			});
			completeSpawnWithOutput(
				[
					'not json',
					JSON.stringify({
						type: 'result',
						result: `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Claude.md
CONTENT:
# Claude
- [ ] Task
---END DOCUMENT---
`,
					}),
				].join('\n')
			);

			const result = await generateInlineDocuments(createConfig({ agentType: 'claude-code' }));

			expect(result.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/bin/claude',
					args: [
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
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-01-Claude.md',
				expect.stringContaining('# Claude'),
				undefined
			);
		});

		it('preserves preconfigured Claude streaming and tool flags', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: ['--include-partial-messages', '--allowedTools', 'Read'],
			});
			completeSpawnWithOutput(
				[
					JSON.stringify({
						type: 'result',
						result: [
							'---BEGIN DOCUMENT---',
							'FILENAME: Phase-01-Claude-Configured.md',
							'CONTENT:',
							'# Claude',
							'- [ ] Task',
							'---END DOCUMENT---',
						].join('\n'),
					}),
				].join('\n')
			);

			const result = await generateInlineDocuments(createConfig({ agentType: 'claude-code' }));

			expect(result.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					args: ['--include-partial-messages', '--allowedTools', 'Read'],
				})
			);
		});

		it('keeps Codex base args and parses Codex agent-message output', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'codex',
				available: true,
				command: 'codex',
				args: ['--sandbox', 'read-only'],
			});
			completeSpawnWithOutput(
				[
					'',
					JSON.stringify({ type: 'event', content: [] }),
					JSON.stringify({
						type: 'agent_message',
						content: [
							{
								type: 'text',
								text: `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Codex.md
CONTENT:
# Codex
- [ ] Task
---END DOCUMENT---
`,
							},
						],
					}),
					JSON.stringify({ type: 'message', text: '\nCodex finished.' }),
				].join('\n')
			);

			const result = await generateInlineDocuments(createConfig({ agentType: 'codex' }));

			expect(result.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'codex',
					args: ['--sandbox', 'read-only'],
				})
			);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-01-Codex.md',
				expect.stringContaining('# Codex'),
				undefined
			);
		});

		it('falls back to raw Codex output when stream-json contains no text', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'codex',
				available: true,
				command: 'codex',
				args: [],
			});
			completeSpawnWithOutput(
				[
					JSON.stringify({
						type: 'agent_message',
						content: [{ type: 'image', text: 'ignored' }],
					}),
					'---BEGIN DOCUMENT---',
					'FILENAME: Phase-01-Codex-Raw.md',
					'CONTENT:',
					'# Codex Raw',
					'- [ ] Task',
					'---END DOCUMENT---',
				].join('\n')
			);

			const result = await generateInlineDocuments(createConfig({ agentType: 'codex' }));

			expect(result.success).toBe(true);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-01-Codex-Raw.md',
				expect.stringContaining('# Codex Raw'),
				undefined
			);
		});

		it('uses default agent args for custom agent ids', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'custom-doc-agent',
				available: true,
				command: 'custom-doc-agent',
				args: ['--custom'],
			});
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Custom.md
CONTENT:
# Custom
- [ ] Task
---END DOCUMENT---
`);

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'custom-doc-agent',
					args: ['--custom'],
				})
			);
		});

		it('builds empty default args for configured agents without args arrays', async () => {
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'claude-code',
				available: true,
				command: 'claude',
			});
			completeSpawnWithOutput(
				[
					JSON.stringify({
						type: 'result',
						result: [
							'---BEGIN DOCUMENT---',
							'FILENAME: Phase-01-Claude-No-Args.md',
							'CONTENT:',
							'# Claude',
							'- [ ] Task',
							'---END DOCUMENT---',
						].join('\n'),
					}),
				].join('\n')
			);

			const claudeResult = await generateInlineDocuments(
				createConfig({ agentType: 'claude-code' })
			);

			expect(claudeResult.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					command: 'claude',
					args: [
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
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'codex',
				available: true,
				command: 'codex',
			});
			completeSpawnWithOutput(`---BEGIN DOCUMENT---
FILENAME: Phase-01-Codex-No-Args.md
CONTENT:
# Codex
- [ ] Task
---END DOCUMENT---`);

			const codexResult = await generateInlineDocuments(createConfig({ agentType: 'codex' }));

			expect(codexResult.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({ command: 'codex', args: [] })
			);

			installMaestro();
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'opencode',
				available: true,
				command: 'opencode',
			});
			completeSpawnWithOutput(`---BEGIN DOCUMENT---
FILENAME: Phase-01-OpenCode-No-Args.md
CONTENT:
# OpenCode
- [ ] Task
---END DOCUMENT---`);

			const opencodeResult = await generateInlineDocuments(createConfig());

			expect(opencodeResult.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({ command: 'opencode', args: [] })
			);

			installMaestro();
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'custom-doc-agent',
				available: true,
				command: 'custom-doc-agent',
			});
			completeSpawnWithOutput(`---BEGIN DOCUMENT---
FILENAME: Phase-01-Custom-No-Args.md
CONTENT:
# Custom
- [ ] Task
---END DOCUMENT---`);

			const customResult = await generateInlineDocuments(createConfig());

			expect(customResult.success).toBe(true);
			expect(mockMaestro.process.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({ command: 'custom-doc-agent', args: [] })
			);
		});

		it('continues after one document save fails and returns the saved documents', async () => {
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Fails.md
CONTENT:
# Fails
- [ ] Task
---END DOCUMENT---

---BEGIN DOCUMENT---
FILENAME: Phase-02-Saves.md
CONTENT:
# Saves
- [ ] Task
---END DOCUMENT---
`);
			mockMaestro.autorun.writeDoc
				.mockResolvedValueOnce({ success: false, error: 'permission denied' })
				.mockResolvedValueOnce({ success: true });

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(result.documents?.map((doc) => doc.filename)).toEqual(['Phase-02-Saves.md']);
			expect(consoleError).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Failed to save document:',
				'Phase-01-Fails.md',
				expect.any(Error)
			);
		});

		it('reports default update-save failures for extensionless update documents', async () => {
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Update
UPDATE: true
CONTENT:
# Update
- [ ] Task
---END DOCUMENT---
`);
			mockMaestro.autorun.writeDoc.mockResolvedValue({ success: false });
			const onError = vi.fn();

			const result = await generateInlineDocuments(createConfig({ callbacks: { onError } }));

			expect(result).toEqual({
				success: false,
				error: 'Failed to save any documents. Please check permissions and try again.',
			});
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-01-Update.md',
				expect.stringContaining('# Update'),
				undefined
			);
			expect(consoleError).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Failed to save document:',
				'Phase-01-Update',
				expect.objectContaining({ message: 'Failed to updated Phase-01-Update.md' })
			);
			expect(onError).toHaveBeenCalledWith(
				'Failed to save any documents. Please check permissions and try again.'
			);
		});

		it('fails when every parsed document save fails', async () => {
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Fails.md
CONTENT:
# Fails
- [ ] Task
---END DOCUMENT---
`);
			mockMaestro.autorun.writeDoc.mockResolvedValue({ success: false, error: 'disk full' });
			const onError = vi.fn();

			const result = await generateInlineDocuments(createConfig({ callbacks: { onError } }));

			expect(result).toEqual({
				success: false,
				error: 'Failed to save any documents. Please check permissions and try again.',
			});
			expect(onError).toHaveBeenCalledWith(
				'Failed to save any documents. Please check permissions and try again.'
			);
		});

		it('falls back to splitting plain output into a phase document', async () => {
			completeSpawnWithOutput('# Manual Plan\n\n- [ ] One task');

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(result.documents?.[0]).toMatchObject({
				filename: 'Phase-01-Initial-Setup.md',
				taskCount: 1,
				content: '# Manual Plan\n\n- [ ] One task',
			});
		});

		it('reads generated documents from disk when output contains no tasks', async () => {
			completeSpawnWithOutput('');
			mockMaestro.autorun.listDocs.mockImplementation(async (path: string) => {
				if (path.includes('/Auto Run Docs/')) {
					return { success: true, files: ['Phase-02-Disk', 'Phase-01-Disk.md'] };
				}
				return { success: true, tree: [] };
			});
			mockMaestro.autorun.readDoc.mockImplementation(async (_path: string, filename: string) => ({
				success: true,
				content: `# ${filename}\n- [ ] Disk task`,
			}));

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-01-Disk.md',
				expect.stringContaining('# Phase-01-Disk.md'),
				undefined
			);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-02-Disk.md',
				expect.stringContaining('# Phase-02-Disk'),
				undefined
			);
		});

		it('skips unreadable disk fallback entries and sorts files without phase numbers first', async () => {
			completeSpawnWithOutput('');
			mockMaestro.autorun.listDocs.mockImplementation(async (path: string) => {
				if (path.includes('/Auto Run Docs/')) {
					return { success: true, files: ['Phase-02-Disk', 'Readme', 'Missing'] };
				}
				return { success: true, tree: [] };
			});
			mockMaestro.autorun.readDoc.mockImplementation(async (_path: string, filename: string) => {
				if (filename === 'Missing') {
					return { success: false };
				}
				return {
					success: true,
					content: `# ${filename}\n- [ ] Disk task`,
				};
			});

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(result.documents?.map((doc) => doc.filename)).toEqual([
				'Readme.md',
				'Phase-02-Disk.md',
			]);
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalledWith(
				expect.any(String),
				'Missing.md',
				expect.any(String),
				undefined
			);
		});

		it('returns a no-documents error when output and disk fallback are empty', async () => {
			completeSpawnWithOutput('');
			const onError = vi.fn();

			const result = await generateInlineDocuments(createConfig({ callbacks: { onError } }));

			expect(result).toEqual({
				success: false,
				error: 'No documents were generated. Please try again.',
			});
			expect(onError).toHaveBeenCalledWith('No documents were generated. Please try again.');
		});

		it('uses documents observed by the file watcher and avoids duplicate watcher events', async () => {
			mockMaestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
				setTimeout(() => {
					const watchedPath = mockMaestro.autorun.watchFolder.mock.calls[0]?.[0] as
						| string
						| undefined;
					capturedFileChangedCallback?.({
						filename: 'Phase-02-Watched',
						eventType: 'rename',
						folderPath: watchedPath ?? '',
					});
					capturedFileChangedCallback?.({
						filename: 'Phase-01-Watched.md',
						eventType: 'change',
						folderPath: watchedPath ?? '',
					});
					capturedFileChangedCallback?.({
						filename: 'Phase-01-Watched.md',
						eventType: 'change',
						folderPath: watchedPath ?? '',
					});
				}, 5);
				setTimeout(() => {
					capturedExitCallback?.(sessionId, 0);
				}, 25);
			});
			mockMaestro.fs.readFile.mockImplementation(async (path: string) =>
				path.includes('Phase-02') ? '# Phase 2\n- [ ] Two' : '# Phase 1\n- [ ] One'
			);
			const onDocumentComplete = vi.fn();

			const result = await generateInlineDocuments(
				createConfig({
					sessionId: 'watch-session',
					callbacks: { onDocumentComplete },
				})
			);

			expect(result.success).toBe(true);
			expect(result.documents?.map((doc) => doc.filename)).toEqual([
				'Phase-01-Watched.md',
				'Phase-02-Watched.md',
			]);
			expect(result.playbook).toEqual({ id: 'playbook-1', name: 'Coverage Project' });
			expect(mockMaestro.playbooks.create).toHaveBeenCalledWith(
				'watch-session',
				expect.objectContaining({
					documents: [
						{
							filename: `${result.subfolderName}/Phase-01-Watched.md`,
							resetOnCompletion: false,
						},
						{
							filename: `${result.subfolderName}/Phase-02-Watched.md`,
							resetOnCompletion: false,
						},
					],
				})
			);
			expect(onDocumentComplete).toHaveBeenCalledTimes(2);
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('ignores unrelated watcher events and watcher reads with empty content', async () => {
			mockMaestro.process.onData.mockImplementationOnce((callback) => {
				capturedDataCallback = callback;
				return undefined;
			});
			mockMaestro.process.onExit.mockImplementationOnce((callback) => {
				capturedExitCallback = callback;
				return undefined;
			});
			mockMaestro.fs.readFile.mockResolvedValue('');
			mockMaestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
				setTimeout(() => {
					const watchedPath = mockMaestro.autorun.watchFolder.mock.calls[0]?.[0] as
						| string
						| undefined;
					capturedFileChangedCallback?.({
						filename: 'Phase-Should-Ignore',
						eventType: 'rename',
						folderPath: '/other/folder',
					});
					capturedFileChangedCallback?.({
						filename: 'Phase-Should-Ignore',
						eventType: 'unlink',
						folderPath: watchedPath ?? '',
					});
					capturedFileChangedCallback?.({
						filename: 'Phase-Empty-Read',
						eventType: 'change',
						folderPath: watchedPath ?? '',
					});
					capturedDataCallback?.('other-session', 'ignored data');
					capturedExitCallback?.('other-session', 0);
					capturedDataCallback?.(
						sessionId,
						`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Fallback.md
CONTENT:
# Fallback
- [ ] Task
---END DOCUMENT---
`
					);
				}, 5);
				setTimeout(() => {
					capturedExitCallback?.(sessionId, 0);
				}, 25);
			});

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(result.documents?.map((doc) => doc.filename)).toEqual(['Phase-01-Fallback.md']);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-01-Fallback.md',
				expect.stringContaining('# Fallback'),
				undefined
			);
		});

		it('sorts watcher documents without phase numbers before numbered phases without playbooks', async () => {
			mockMaestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
				setTimeout(() => {
					const watchedPath = mockMaestro.autorun.watchFolder.mock.calls[0]?.[0] as
						| string
						| undefined;
					for (const filename of ['Phase-02-Watched', 'Notes', 'Phase-01-Watched']) {
						capturedFileChangedCallback?.({
							filename,
							eventType: 'rename',
							folderPath: watchedPath ?? '',
						});
					}
				}, 5);
				setTimeout(() => {
					capturedExitCallback?.(sessionId, 0);
				}, 25);
			});
			mockMaestro.fs.readFile.mockImplementation(async (path: string) =>
				path.includes('Notes') ? '# Notes\n- [ ] Triage' : `# ${path}\n- [ ] Task`
			);
			const onComplete = vi.fn();

			const result = await generateInlineDocuments(createConfig({ callbacks: { onComplete } }));

			expect(result.success).toBe(true);
			expect(result.documents?.map((doc) => doc.filename)).toEqual([
				'Notes.md',
				'Phase-01-Watched.md',
				'Phase-02-Watched.md',
			]);
			expect(result.playbook).toBeUndefined();
			expect(mockMaestro.playbooks.create).not.toHaveBeenCalled();
			expect(onComplete).toHaveBeenCalledWith(result.documents);
		});

		it('logs watcher read retry failures and falls back to marker output', async () => {
			vi.useFakeTimers();
			const readError = new Error('file still locked');
			mockMaestro.fs.readFile.mockRejectedValue(readError);
			mockMaestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
				setTimeout(() => {
					const watchedPath = mockMaestro.autorun.watchFolder.mock.calls[0]?.[0] as
						| string
						| undefined;
					capturedFileChangedCallback?.({
						filename: 'Phase-Read-Fail',
						eventType: 'rename',
						folderPath: watchedPath ?? '',
					});
				}, 0);
				setTimeout(() => {
					capturedDataCallback?.(
						sessionId,
						`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Fallback.md
CONTENT:
# Fallback
- [ ] Task
---END DOCUMENT---
`
					);
					capturedExitCallback?.(sessionId, 0);
				}, 700);
			});

			const generationPromise = generateInlineDocuments(createConfig());
			await vi.advanceTimersByTimeAsync(1000);
			const result = await generationPromise;

			expect(result.success).toBe(true);
			expect(result.documents?.map((doc) => doc.filename)).toEqual(['Phase-01-Fallback.md']);
			expect(consoleLog).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Could not read file content:',
				'Phase-Read-Fail.md'
			);
			expect(consoleLog).toHaveBeenCalledWith(
				expect.stringContaining(
					'[InlineWizardDocGen] File read attempt 3/3 failed for Phase-Read-Fail.md:'
				),
				readError
			);
		});

		it('logs watcher playbook creation failures without failing watched documents', async () => {
			mockMaestro.playbooks.create.mockResolvedValue({ success: false });
			mockMaestro.process.spawn.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
				setTimeout(() => {
					const watchedPath = mockMaestro.autorun.watchFolder.mock.calls[0]?.[0] as
						| string
						| undefined;
					capturedFileChangedCallback?.({
						filename: 'Phase-01-Watched',
						eventType: 'rename',
						folderPath: watchedPath ?? '',
					});
				}, 5);
				setTimeout(() => {
					capturedExitCallback?.(sessionId, 0);
				}, 25);
			});
			mockMaestro.fs.readFile.mockResolvedValue('# Watched\n- [ ] Task');

			const result = await generateInlineDocuments(createConfig({ sessionId: 'watch-session' }));

			expect(result.success).toBe(true);
			expect(result.playbook).toBeUndefined();
			expect(consoleError).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Failed to create playbook:',
				expect.any(Error)
			);
		});

		it('logs watcher setup failures without failing generation', async () => {
			mockMaestro.autorun.watchFolder.mockResolvedValue({ success: false, error: 'watch denied' });
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task
---END DOCUMENT---
`);

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(consoleWarn).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Could not watch folder:',
				'watch denied'
			);
		});

		it('logs watcher setup rejections without failing generation', async () => {
			const watchError = new Error('watch exploded');
			mockMaestro.autorun.watchFolder.mockRejectedValue(watchError);
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task
---END DOCUMENT---
`);

			const result = await generateInlineDocuments(createConfig());

			expect(result.success).toBe(true);
			expect(consoleWarn).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Error setting up folder watcher:',
				watchError
			);
		});

		it('logs playbook creation failures without failing document generation', async () => {
			mockMaestro.playbooks.create.mockResolvedValue({ success: false });
			completeSpawnWithOutput(`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task
---END DOCUMENT---
`);

			const result = await generateInlineDocuments(createConfig({ sessionId: 'session-1' }));

			expect(result.success).toBe(true);
			expect(result.playbook).toBeUndefined();
			expect(consoleError).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Failed to create playbook:',
				expect.any(Error)
			);
		});

		it('logs disk fallback read errors and returns a no-documents failure', async () => {
			const diskError = new Error('cannot list disk docs');
			completeSpawnWithOutput('');
			mockMaestro.autorun.listDocs.mockImplementation(async (path: string) => {
				if (path.includes('/Auto Run Docs/')) {
					throw diskError;
				}
				return { success: true, tree: [] };
			});

			const result = await generateInlineDocuments(createConfig());

			expect(result).toEqual({
				success: false,
				error: 'No documents were generated. Please try again.',
			});
			expect(consoleError).toHaveBeenCalledWith(
				'[InlineWizardDocGen] Error reading documents from disk:',
				diskError
			);
		});

		it('reports non-Error setup failures as unknown errors', async () => {
			mockMaestro.agents.get.mockRejectedValue('offline');
			const onError = vi.fn();

			const result = await generateInlineDocuments(createConfig({ callbacks: { onError } }));

			expect(result).toEqual({ success: false, error: 'Unknown error occurred' });
			expect(consoleError).toHaveBeenCalledWith('[InlineWizardDocGen] Error:', 'offline');
			expect(onError).toHaveBeenCalledWith('Unknown error occurred');
		});

		it('uses local folder collision checks when remote config has no selected remote', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'opencode',
				available: true,
				command: 'opencode',
			});
			completeSpawnWithOutput(`---BEGIN DOCUMENT---
FILENAME: Phase-01-Remote-Null.md
CONTENT:
# Remote Null
- [ ] Task
---END DOCUMENT---`);

			const result = await generateInlineDocuments(
				createConfig({
					sessionSshRemoteConfig: { enabled: true, remoteId: null },
				})
			);

			expect(result.success).toBe(true);
			expect(mockMaestro.autorun.watchFolder).toHaveBeenCalledWith(expect.any(String), undefined);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.any(String),
				'Phase-01-Remote-Null.md',
				expect.stringContaining('# Remote Null'),
				undefined
			);
		});

		it('times out and kills the spawned process when the agent never exits', async () => {
			vi.useFakeTimers();
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			mockMaestro.process.kill.mockRejectedValueOnce(new Error('kill failed'));
			mockMaestro.autorun.unwatchFolder.mockRejectedValueOnce(new Error('unwatch failed'));

			const generationPromise = generateInlineDocuments(createConfig());
			await vi.advanceTimersByTimeAsync(1_200_000);
			const result = await generationPromise;

			expect(result).toMatchObject({
				success: false,
				error: 'Generation timed out after 20 minutes. Please try again.',
			});
			expect(mockMaestro.process.kill).toHaveBeenCalledWith(
				mockMaestro.process.spawn.mock.calls[0][0].sessionId
			);
			expect(mockMaestro.autorun.unwatchFolder).toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalledWith(
				'[InlineWizardDocGen] TIMEOUT fired! Session:',
				mockMaestro.process.spawn.mock.calls[0][0].sessionId
			);
		});

		it('uses the inactivity timeout message after data has streamed', async () => {
			vi.useFakeTimers();
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			mockMaestro.process.kill.mockRejectedValueOnce(new Error('kill failed'));

			const generationPromise = generateInlineDocuments(createConfig());
			for (let i = 0; i < 5 && mockMaestro.process.spawn.mock.calls.length === 0; i++) {
				await Promise.resolve();
			}
			const sessionId = mockMaestro.process.spawn.mock.calls[0][0].sessionId;
			capturedDataCallback?.(sessionId, 'partial output');

			await vi.advanceTimersByTimeAsync(1_200_000);
			const result = await generationPromise;

			expect(result).toMatchObject({
				success: false,
				error: 'Generation timed out after 20 minutes of inactivity. Please try again.',
				rawOutput: 'partial output',
			});
			expect(mockMaestro.process.kill).toHaveBeenCalledWith(sessionId);
		});
	});
});
