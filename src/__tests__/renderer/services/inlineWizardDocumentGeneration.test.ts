/**
 * Tests for inlineWizardDocumentGeneration.ts
 *
 * These tests verify the document parsing and iterate mode functionality.
 */

import { describe, it, expect } from 'vitest';
import {
	parseGeneratedDocuments,
	splitIntoPhases,
	sanitizeFilename,
	generateWizardFolderBaseName,
	countTasks,
	generateDocumentPrompt,
	type DocumentGenerationConfig,
} from '../../../renderer/services/inlineWizardDocumentGeneration';

describe('inlineWizardDocumentGeneration', () => {
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
		it('should generate date-based folder name in Wizard-YYYY-MM-DD format', () => {
			const result = generateWizardFolderBaseName();

			// Should match the pattern Wizard-YYYY-MM-DD
			expect(result).toMatch(/^Wizard-\d{4}-\d{2}-\d{2}$/);
		});

		it('should use current date', () => {
			const now = new Date();
			const year = now.getFullYear();
			const month = String(now.getMonth() + 1).padStart(2, '0');
			const day = String(now.getDate()).padStart(2, '0');
			const expected = `Wizard-${year}-${month}-${day}`;

			expect(generateWizardFolderBaseName()).toBe(expected);
		});

		it('should pad single-digit months and days with zeros', () => {
			const result = generateWizardFolderBaseName();

			// Extract month and day parts
			const parts = result.split('-');
			const month = parts[2];
			const day = parts[3];

			// Should be exactly 2 digits
			expect(month).toHaveLength(2);
			expect(day).toHaveLength(2);
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
});
