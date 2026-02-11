/**
 * Tests for src/main/vibes/vibes-io.ts
 * Validates the VIBES file I/O module: reading/writing config, manifest,
 * and annotations in the .ai-audit/ directory structure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access, constants } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
	ensureAuditDir,
	readVibesConfig,
	writeVibesConfig,
	readVibesManifest,
	writeVibesManifest,
	appendAnnotation,
	appendAnnotations,
	readAnnotations,
	addManifestEntry,
} from '../../../main/vibes/vibes-io';

import type {
	VibesConfig,
	VibesManifest,
	VibesLineAnnotation,
	VibeFunctionAnnotation,
	VibesSessionRecord,
	VibesEnvironmentEntry,
	VibesCommandEntry,
	VibesPromptEntry,
} from '../../../shared/vibes-types';

// ============================================================================
// Test Fixtures
// ============================================================================

const SAMPLE_CONFIG: VibesConfig = {
	standard: 'VIBES',
	standard_version: '1.0',
	assurance_level: 'medium',
	project_name: 'test-project',
	tracked_extensions: ['.ts', '.js'],
	exclude_patterns: ['**/node_modules/**'],
	compress_reasoning_threshold_bytes: 10240,
	external_blob_threshold_bytes: 102400,
};

const SAMPLE_LINE_ANNOTATION: VibesLineAnnotation = {
	type: 'line',
	file_path: 'src/index.ts',
	line_start: 1,
	line_end: 10,
	environment_hash: 'abc123def456789012345678901234567890123456789012345678901234',
	action: 'create',
	timestamp: '2026-02-10T12:00:00Z',
	assurance_level: 'medium',
};

const SAMPLE_FUNCTION_ANNOTATION: VibeFunctionAnnotation = {
	type: 'function',
	file_path: 'src/utils.ts',
	function_name: 'computeHash',
	function_signature: 'computeHash(data: string): string',
	environment_hash: 'def456789012345678901234567890123456789012345678901234567890ab',
	action: 'modify',
	timestamp: '2026-02-10T12:05:00Z',
	assurance_level: 'high',
};

const SAMPLE_SESSION_RECORD: VibesSessionRecord = {
	type: 'session',
	event: 'start',
	session_id: 'session-001',
	timestamp: '2026-02-10T12:00:00Z',
	assurance_level: 'medium',
};

const SAMPLE_ENVIRONMENT_ENTRY: VibesEnvironmentEntry = {
	type: 'environment',
	tool_name: 'maestro',
	tool_version: '2.0',
	model_name: 'claude-4',
	model_version: 'opus',
	created_at: '2026-02-10T12:00:00Z',
};

// ============================================================================
// Test Suite
// ============================================================================

describe('vibes-io', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-io-test-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// ensureAuditDir
	// ========================================================================
	describe('ensureAuditDir', () => {
		it('should create .ai-audit/ and .ai-audit/blobs/ directories', async () => {
			await ensureAuditDir(tmpDir);

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
			await expect(access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK)).resolves.toBeUndefined();
		});

		it('should be idempotent (safe to call multiple times)', async () => {
			await ensureAuditDir(tmpDir);
			await ensureAuditDir(tmpDir);

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
			await expect(access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK)).resolves.toBeUndefined();
		});
	});

	// ========================================================================
	// readVibesConfig / writeVibesConfig
	// ========================================================================
	describe('readVibesConfig', () => {
		it('should return null when config does not exist', async () => {
			const config = await readVibesConfig(tmpDir);
			expect(config).toBeNull();
		});

		it('should return null when .ai-audit/ directory does not exist', async () => {
			const config = await readVibesConfig(path.join(tmpDir, 'nonexistent'));
			expect(config).toBeNull();
		});
	});

	describe('writeVibesConfig', () => {
		it('should write config.json with pretty formatting', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'config.json'), 'utf8');
			expect(raw).toContain('\t');
			expect(raw.endsWith('\n')).toBe(true);

			const parsed = JSON.parse(raw);
			expect(parsed).toEqual(SAMPLE_CONFIG);
		});

		it('should create .ai-audit/ directory if it does not exist', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
		});
	});

	describe('readVibesConfig + writeVibesConfig roundtrip', () => {
		it('should roundtrip config data correctly', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);
			const config = await readVibesConfig(tmpDir);

			expect(config).toEqual(SAMPLE_CONFIG);
		});

		it('should handle config with all fields', async () => {
			const fullConfig: VibesConfig = {
				standard: 'VIBES',
				standard_version: '1.0',
				assurance_level: 'high',
				project_name: 'full-project',
				tracked_extensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs'],
				exclude_patterns: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
				compress_reasoning_threshold_bytes: 5120,
				external_blob_threshold_bytes: 51200,
			};

			await writeVibesConfig(tmpDir, fullConfig);
			const config = await readVibesConfig(tmpDir);

			expect(config).toEqual(fullConfig);
		});

		it('should overwrite existing config', async () => {
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			const updatedConfig: VibesConfig = {
				...SAMPLE_CONFIG,
				assurance_level: 'high',
				project_name: 'updated-project',
			};
			await writeVibesConfig(tmpDir, updatedConfig);

			const config = await readVibesConfig(tmpDir);
			expect(config).toEqual(updatedConfig);
		});
	});

	// ========================================================================
	// readVibesManifest / writeVibesManifest
	// ========================================================================
	describe('readVibesManifest', () => {
		it('should return empty manifest when file does not exist', async () => {
			const manifest = await readVibesManifest(tmpDir);

			expect(manifest).toEqual({
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			});
		});

		it('should return empty manifest when .ai-audit/ does not exist', async () => {
			const manifest = await readVibesManifest(path.join(tmpDir, 'nonexistent'));

			expect(manifest).toEqual({
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			});
		});
	});

	describe('writeVibesManifest', () => {
		it('should write manifest.json with pretty formatting', async () => {
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			};
			await writeVibesManifest(tmpDir, manifest);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'manifest.json'), 'utf8');
			expect(raw).toContain('\t');
			expect(raw.endsWith('\n')).toBe(true);

			const parsed = JSON.parse(raw);
			expect(parsed).toEqual(manifest);
		});

		it('should create .ai-audit/ directory if it does not exist', async () => {
			await writeVibesManifest(tmpDir, { standard: 'VIBES', version: '1.0', entries: {} });

			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
		});
	});

	describe('readVibesManifest + writeVibesManifest roundtrip', () => {
		it('should roundtrip manifest with entries', async () => {
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					'abc123': SAMPLE_ENVIRONMENT_ENTRY,
					'def456': {
						type: 'command',
						command_text: 'npm test',
						command_type: 'shell',
						command_exit_code: 0,
						created_at: '2026-02-10T12:01:00Z',
					} as VibesCommandEntry,
				},
			};

			await writeVibesManifest(tmpDir, manifest);
			const result = await readVibesManifest(tmpDir);

			expect(result).toEqual(manifest);
		});
	});

	// ========================================================================
	// appendAnnotation / readAnnotations
	// ========================================================================
	describe('appendAnnotation', () => {
		it('should create annotations.jsonl if it does not exist', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);

			await expect(
				access(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), constants.F_OK),
			).resolves.toBeUndefined();
		});

		it('should write a single JSONL line', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), 'utf8');
			const lines = raw.trim().split('\n');

			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_LINE_ANNOTATION);
		});

		it('should append subsequent annotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), 'utf8');
			const lines = raw.trim().split('\n');

			expect(lines).toHaveLength(3);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(JSON.parse(lines[1])).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(JSON.parse(lines[2])).toEqual(SAMPLE_SESSION_RECORD);
		});
	});

	describe('appendAnnotations', () => {
		it('should write multiple annotations in a single call', async () => {
			const annotations = [SAMPLE_LINE_ANNOTATION, SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD];
			await appendAnnotations(tmpDir, annotations);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), 'utf8');
			const lines = raw.trim().split('\n');

			expect(lines).toHaveLength(3);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(JSON.parse(lines[1])).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(JSON.parse(lines[2])).toEqual(SAMPLE_SESSION_RECORD);
		});

		it('should handle empty array without creating file', async () => {
			await appendAnnotations(tmpDir, []);

			await expect(
				access(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), constants.F_OK),
			).rejects.toThrow();
		});

		it('should append to existing annotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotations(tmpDir, [SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD]);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), 'utf8');
			const lines = raw.trim().split('\n');

			expect(lines).toHaveLength(3);
		});

		it('should write a single annotation', async () => {
			await appendAnnotations(tmpDir, [SAMPLE_LINE_ANNOTATION]);

			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), 'utf8');
			const lines = raw.trim().split('\n');

			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_LINE_ANNOTATION);
		});
	});

	describe('readAnnotations', () => {
		it('should return empty array when file does not exist', async () => {
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toEqual([]);
		});

		it('should return empty array when .ai-audit/ does not exist', async () => {
			const annotations = await readAnnotations(path.join(tmpDir, 'nonexistent'));
			expect(annotations).toEqual([]);
		});

		it('should parse all annotation types', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD);

			const annotations = await readAnnotations(tmpDir);

			expect(annotations).toHaveLength(3);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(annotations[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(annotations[2]).toEqual(SAMPLE_SESSION_RECORD);
		});

		it('should skip blank lines', async () => {
			await ensureAuditDir(tmpDir);
			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const content = JSON.stringify(SAMPLE_LINE_ANNOTATION) + '\n\n' +
				JSON.stringify(SAMPLE_FUNCTION_ANNOTATION) + '\n\n';
			const { writeFile: wf } = await import('fs/promises');
			await wf(annotationsPath, content, 'utf8');

			const annotations = await readAnnotations(tmpDir);

			expect(annotations).toHaveLength(2);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(annotations[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
		});
	});

	// ========================================================================
	// addManifestEntry
	// ========================================================================
	describe('addManifestEntry', () => {
		it('should add a new entry to an empty manifest', async () => {
			const hash = 'abc123def456789012345678901234567890123456789012345678901234';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should not overwrite an existing entry with the same hash', async () => {
			const hash = 'abc123def456789012345678901234567890123456789012345678901234';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			const differentEntry: VibesPromptEntry = {
				type: 'prompt',
				prompt_text: 'different prompt',
				created_at: '2026-02-10T13:00:00Z',
			};
			await addManifestEntry(tmpDir, hash, differentEntry);

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should add multiple entries with different hashes', async () => {
			const hash1 = 'abc123def456789012345678901234567890123456789012345678901234';
			const hash2 = 'def456789012345678901234567890123456789012345678901234567890';
			const hash3 = '789012345678901234567890123456789012345678901234567890abcdef';

			const commandEntry: VibesCommandEntry = {
				type: 'command',
				command_text: 'npm test',
				command_type: 'shell',
				created_at: '2026-02-10T12:01:00Z',
			};

			const promptEntry: VibesPromptEntry = {
				type: 'prompt',
				prompt_text: 'Add unit tests',
				prompt_type: 'user_instruction',
				created_at: '2026-02-10T12:02:00Z',
			};

			await addManifestEntry(tmpDir, hash1, SAMPLE_ENVIRONMENT_ENTRY);
			await addManifestEntry(tmpDir, hash2, commandEntry);
			await addManifestEntry(tmpDir, hash3, promptEntry);

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(3);
			expect(manifest.entries[hash1]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
			expect(manifest.entries[hash2]).toEqual(commandEntry);
			expect(manifest.entries[hash3]).toEqual(promptEntry);
		});

		it('should preserve existing manifest structure', async () => {
			// Pre-populate manifest with a custom structure
			const existingManifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {
					'existing-hash': SAMPLE_ENVIRONMENT_ENTRY,
				},
			};
			await writeVibesManifest(tmpDir, existingManifest);

			const newHash = 'new-hash-value-012345678901234567890123456789012345678901234';
			const commandEntry: VibesCommandEntry = {
				type: 'command',
				command_text: 'git commit',
				command_type: 'shell',
				created_at: '2026-02-10T12:03:00Z',
			};
			await addManifestEntry(tmpDir, newHash, commandEntry);

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.standard).toBe('VIBES');
			expect(manifest.version).toBe('1.0');
			expect(Object.keys(manifest.entries)).toHaveLength(2);
			expect(manifest.entries['existing-hash']).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
			expect(manifest.entries[newHash]).toEqual(commandEntry);
		});
	});

	// ========================================================================
	// Integration: Full Workflow
	// ========================================================================
	describe('integration', () => {
		it('should support a full audit directory workflow', async () => {
			// 1. Ensure directory exists
			await ensureAuditDir(tmpDir);

			// 2. Write config
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);
			const config = await readVibesConfig(tmpDir);
			expect(config).toEqual(SAMPLE_CONFIG);

			// 3. Add manifest entries
			const envHash = 'env-hash-0123456789012345678901234567890123456789012345678901';
			await addManifestEntry(tmpDir, envHash, SAMPLE_ENVIRONMENT_ENTRY);

			// 4. Write annotations
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotations(tmpDir, [SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD]);

			// 5. Read back everything
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(1);
			expect(manifest.entries[envHash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(3);
			expect(annotations[0].type).toBe('line');
			expect(annotations[1].type).toBe('function');
			expect(annotations[2].type).toBe('session');
		});
	});
});
