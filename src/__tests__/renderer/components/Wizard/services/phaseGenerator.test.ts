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

import { describe, it, expect } from 'vitest';
import {
	parseGeneratedDocuments,
	splitIntoPhases,
	countTasks,
	validateDocuments,
	sanitizeFilename,
} from '../../../../../renderer/components/Wizard/services/phaseGenerator';

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
