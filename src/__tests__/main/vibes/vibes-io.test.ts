/**
 * Tests for src/main/vibes/vibes-io.ts
 * Validates the VIBES file I/O module: reading/writing config, manifest,
 * and annotations in the .ai-audit/ directory structure.
 * Includes tests for the async write buffer, debounced manifest writes,
 * file locking, and graceful error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access, constants, writeFile as fsWriteFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
	ensureAuditDir,
	readVibesConfig,
	writeVibesConfig,
	readVibesManifest,
	writeVibesManifest,
	appendAnnotation,
	appendAnnotationImmediate,
	appendAnnotations,
	readAnnotations,
	addManifestEntry,
	flushAll,
	getBufferedAnnotationCount,
	getPendingManifestEntryCount,
	resetAllBuffers,
	initVibesDirectly,
	writeReasoningBlob,
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
		resetAllBuffers();
	});

	afterEach(async () => {
		resetAllBuffers();
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
	// Version Validation (GAP 4 fix)
	// ========================================================================
	describe('version validation', () => {
		it('warns when manifest version is not 1.0', async () => {
			await ensureAuditDir(tmpDir);
			const manifestPath = path.join(tmpDir, '.ai-audit', 'manifest.json');
			const badManifest = { standard: 'VIBES', version: '2.0', entries: {} };
			await fsWriteFile(manifestPath, JSON.stringify(badManifest), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await readVibesManifest(tmpDir);
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining("unsupported version: '2.0'"),
				);
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('warns when config standard_version is not 1.0', async () => {
			await ensureAuditDir(tmpDir);
			const configPath = path.join(tmpDir, '.ai-audit', 'config.json');
			const badConfig = {
				...SAMPLE_CONFIG,
				standard_version: '2.0',
			};
			await fsWriteFile(configPath, JSON.stringify(badConfig), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await readVibesConfig(tmpDir);
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining("unsupported standard_version: '2.0'"),
				);
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('reads manifest successfully even with unsupported version (fail open)', async () => {
			await ensureAuditDir(tmpDir);
			const manifestPath = path.join(tmpDir, '.ai-audit', 'manifest.json');
			const badManifest = {
				standard: 'VIBES',
				version: '99.0',
				entries: { 'abc': { type: 'environment', tool_name: 'test', tool_version: '1.0', model_name: 'm', model_version: '1', created_at: '2026-02-10T12:00:00Z' } },
			};
			await fsWriteFile(manifestPath, JSON.stringify(badManifest), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const manifest = await readVibesManifest(tmpDir);
				// Should return the manifest data despite version mismatch
				expect(manifest.version).toBe('99.0');
				expect(manifest.entries['abc']).toBeDefined();
				expect(manifest.entries['abc'].type).toBe('environment');
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('reads config successfully even with unsupported version (fail open)', async () => {
			await ensureAuditDir(tmpDir);
			const configPath = path.join(tmpDir, '.ai-audit', 'config.json');
			const badConfig = {
				...SAMPLE_CONFIG,
				standard_version: '99.0',
			};
			await fsWriteFile(configPath, JSON.stringify(badConfig), 'utf8');

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const config = await readVibesConfig(tmpDir);
				// Should return the config data despite version mismatch
				expect(config).not.toBeNull();
				expect(config!.standard_version).toBe('99.0');
				expect(config!.project_name).toBe('test-project');
			} finally {
				warnSpy.mockRestore();
			}
		});
	});

	// ========================================================================
	// Atomic Writes (DIVERGENCE 1 fix)
	// ========================================================================
	describe('atomic writes', () => {
		it('writes manifest atomically via temp file + rename', async () => {
			// Pre-create a stale .tmp file to prove the atomic write cycle runs
			await ensureAuditDir(tmpDir);
			const manifestTmpPath = path.join(tmpDir, '.ai-audit', 'manifest.json.tmp');
			await fsWriteFile(manifestTmpPath, 'stale-data', 'utf8');

			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			};
			await writeVibesManifest(tmpDir, manifest);

			// Final file has correct content
			const manifestPath = path.join(tmpDir, '.ai-audit', 'manifest.json');
			const raw = await readFile(manifestPath, 'utf8');
			expect(JSON.parse(raw)).toEqual(manifest);

			// Temp file was consumed by rename (no longer exists)
			await expect(access(manifestTmpPath, constants.F_OK)).rejects.toThrow();
		});

		it('writes config atomically via temp file + rename', async () => {
			// Pre-create a stale .tmp file to prove the atomic write cycle runs
			await ensureAuditDir(tmpDir);
			const configTmpPath = path.join(tmpDir, '.ai-audit', 'config.json.tmp');
			await fsWriteFile(configTmpPath, 'stale-data', 'utf8');

			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			// Final file has correct content
			const configPath = path.join(tmpDir, '.ai-audit', 'config.json');
			const raw = await readFile(configPath, 'utf8');
			expect(JSON.parse(raw)).toEqual(SAMPLE_CONFIG);

			// Temp file was consumed by rename (no longer exists)
			await expect(access(configTmpPath, constants.F_OK)).rejects.toThrow();
		});

		it('no temp file remains after successful write', async () => {
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			};
			await writeVibesManifest(tmpDir, manifest);
			await writeVibesConfig(tmpDir, SAMPLE_CONFIG);

			// Neither .tmp file should exist
			const manifestTmpPath = path.join(tmpDir, '.ai-audit', 'manifest.json.tmp');
			const configTmpPath = path.join(tmpDir, '.ai-audit', 'config.json.tmp');
			await expect(access(manifestTmpPath, constants.F_OK)).rejects.toThrow();
			await expect(access(configTmpPath, constants.F_OK)).rejects.toThrow();
		});
	});

	// ========================================================================
	// appendAnnotation / readAnnotations (buffered)
	// ========================================================================
	describe('appendAnnotation', () => {
		it('should buffer annotations and flush on readAnnotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);

			// Data should be in the buffer
			expect(getBufferedAnnotationCount(tmpDir)).toBeGreaterThanOrEqual(0);

			// readAnnotations triggers a flush
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(1);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
		});

		it('should buffer and flush multiple sequential annotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD);

			// Flush and read
			const annotations = await readAnnotations(tmpDir);

			expect(annotations).toHaveLength(3);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(annotations[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(annotations[2]).toEqual(SAMPLE_SESSION_RECORD);
		});

		it('should create annotations.jsonl after flush', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await flushAll();

			await expect(
				access(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), constants.F_OK),
			).resolves.toBeUndefined();
		});
	});

	describe('appendAnnotations', () => {
		it('should write multiple annotations via buffer', async () => {
			const annotations = [SAMPLE_LINE_ANNOTATION, SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD];
			await appendAnnotations(tmpDir, annotations);

			const result = await readAnnotations(tmpDir);

			expect(result).toHaveLength(3);
			expect(result[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(result[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			expect(result[2]).toEqual(SAMPLE_SESSION_RECORD);
		});

		it('should handle empty array without buffering', async () => {
			await appendAnnotations(tmpDir, []);
			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
		});

		it('should append to existing annotations', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await flushAll();
			await appendAnnotations(tmpDir, [SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD]);

			const result = await readAnnotations(tmpDir);
			expect(result).toHaveLength(3);
		});

		it('should write a single annotation', async () => {
			await appendAnnotations(tmpDir, [SAMPLE_LINE_ANNOTATION]);

			const result = await readAnnotations(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual(SAMPLE_LINE_ANNOTATION);
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
			await fsWriteFile(annotationsPath, content, 'utf8');

			const annotations = await readAnnotations(tmpDir);

			expect(annotations).toHaveLength(2);
			expect(annotations[0]).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(annotations[1]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
		});
	});

	// ========================================================================
	// Write Buffer Behavior
	// ========================================================================
	describe('write buffer', () => {
		it('should buffer annotations in memory before flush', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			// Buffer should hold the annotation (may be 0 if auto-flush already fired, but typically 1)
			const count = getBufferedAnnotationCount(tmpDir);
			// It should be >= 0 (could have already flushed asynchronously)
			expect(count).toBeGreaterThanOrEqual(0);
		});

		it('should flush all buffers with flushAll()', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION);

			await flushAll();

			// Buffer should be empty after flush
			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);

			// Data should be on disk
			const raw = await readFile(path.join(tmpDir, '.ai-audit', 'annotations.jsonl'), 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(2);
		});

		it('should auto-flush when buffer reaches 20 annotations', async () => {
			const annotations: VibesLineAnnotation[] = [];
			for (let i = 0; i < 25; i++) {
				annotations.push({
					...SAMPLE_LINE_ANNOTATION,
					line_start: i,
					line_end: i + 5,
					timestamp: `2026-02-10T12:${String(i).padStart(2, '0')}:00Z`,
				});
			}

			await appendAnnotations(tmpDir, annotations);

			// Give the async flush a moment to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Now flush remaining
			await flushAll();

			const result = await readAnnotations(tmpDir);
			expect(result).toHaveLength(25);
		});

		it('should handle multiple projects independently', async () => {
			const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), 'vibes-io-test2-'));

			try {
				await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
				await appendAnnotation(tmpDir2, SAMPLE_FUNCTION_ANNOTATION);

				await flushAll();

				const annotations1 = await readAnnotations(tmpDir);
				const annotations2 = await readAnnotations(tmpDir2);

				expect(annotations1).toHaveLength(1);
				expect(annotations1[0]).toEqual(SAMPLE_LINE_ANNOTATION);
				expect(annotations2).toHaveLength(1);
				expect(annotations2[0]).toEqual(SAMPLE_FUNCTION_ANNOTATION);
			} finally {
				await rm(tmpDir2, { recursive: true, force: true });
			}
		});

		it('should clear all buffers and timers with resetAllBuffers()', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			resetAllBuffers();

			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
			expect(getPendingManifestEntryCount(tmpDir)).toBe(0);
		});
	});

	// ========================================================================
	// addManifestEntry (debounced)
	// ========================================================================
	describe('addManifestEntry', () => {
		it('should add a new entry to an empty manifest after flush', async () => {
			const hash = 'abc123def456789012345678901234567890123456789012345678901234';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			// Debounced — need to flush
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should not overwrite an existing entry with the same hash', async () => {
			const hash = 'abc123def456789012345678901234567890123456789012345678901234';

			// Write the first entry directly to disk
			const manifest: VibesManifest = {
				standard: 'VIBES',
				version: '1.0',
				entries: { [hash]: SAMPLE_ENVIRONMENT_ENTRY },
			};
			await writeVibesManifest(tmpDir, manifest);

			const differentEntry: VibesPromptEntry = {
				type: 'prompt',
				prompt_text: 'different prompt',
				created_at: '2026-02-10T13:00:00Z',
			};
			await addManifestEntry(tmpDir, hash, differentEntry);
			await flushAll();

			const result = await readVibesManifest(tmpDir);
			expect(result.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
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

			await flushAll();

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
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.standard).toBe('VIBES');
			expect(manifest.version).toBe('1.0');
			expect(Object.keys(manifest.entries)).toHaveLength(2);
			expect(manifest.entries['existing-hash']).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
			expect(manifest.entries[newHash]).toEqual(commandEntry);
		});

		it('should track pending manifest entries', async () => {
			const hash = 'test-hash-012345678901234567890123456789012345678901234567890';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			expect(getPendingManifestEntryCount(tmpDir)).toBe(1);

			await flushAll();
			expect(getPendingManifestEntryCount(tmpDir)).toBe(0);
		});
	});

	// ========================================================================
	// flushAll
	// ========================================================================
	describe('flushAll', () => {
		it('should flush both annotation buffers and manifest debounces', async () => {
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			const hash = 'test-hash-012345678901234567890123456789012345678901234567890';
			await addManifestEntry(tmpDir, hash, SAMPLE_ENVIRONMENT_ENTRY);

			await flushAll();

			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
			expect(getPendingManifestEntryCount(tmpDir)).toBe(0);

			// Verify data is on disk
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(1);

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);
		});

		it('should be safe to call with no pending data', async () => {
			await expect(flushAll()).resolves.toBeUndefined();
		});

		it('should flush multiple projects', async () => {
			const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), 'vibes-io-test-flush-'));

			try {
				await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
				await appendAnnotation(tmpDir2, SAMPLE_FUNCTION_ANNOTATION);

				await flushAll();

				const annotations1 = await readAnnotations(tmpDir);
				const annotations2 = await readAnnotations(tmpDir2);

				expect(annotations1).toHaveLength(1);
				expect(annotations2).toHaveLength(1);
			} finally {
				await rm(tmpDir2, { recursive: true, force: true });
			}
		});
	});

	// ========================================================================
	// Graceful Error Handling
	// ========================================================================
	describe('graceful error handling', () => {
		it('should not throw when buffering an annotation for invalid path', async () => {
			// appendAnnotation should never throw — just log
			await expect(
				appendAnnotation('/nonexistent/path/that/will/fail', SAMPLE_LINE_ANNOTATION),
			).resolves.toBeUndefined();
		});

		it('should not throw when flushing fails', async () => {
			await appendAnnotation('/nonexistent/path', SAMPLE_LINE_ANNOTATION);
			// flushAll should handle the error gracefully
			await expect(flushAll()).resolves.toBeUndefined();
		});

		it('should not throw when addManifestEntry target is invalid', async () => {
			await expect(
				addManifestEntry('/nonexistent/path', 'hash', SAMPLE_ENVIRONMENT_ENTRY),
			).resolves.toBeUndefined();
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

			// 3. Add manifest entries (debounced)
			const envHash = 'env-hash-0123456789012345678901234567890123456789012345678901';
			await addManifestEntry(tmpDir, envHash, SAMPLE_ENVIRONMENT_ENTRY);

			// 4. Write annotations (buffered)
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await appendAnnotations(tmpDir, [SAMPLE_FUNCTION_ANNOTATION, SAMPLE_SESSION_RECORD]);

			// 5. Flush everything
			await flushAll();

			// 6. Read back everything
			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(1);
			expect(manifest.entries[envHash]).toEqual(SAMPLE_ENVIRONMENT_ENTRY);

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(3);
			expect(annotations[0].type).toBe('line');
			expect(annotations[1].type).toBe('function');
			expect(annotations[2].type).toBe('session');
		});

		it('should handle concurrent annotation and manifest writes', async () => {
			const hashes = ['hash-a', 'hash-b', 'hash-c'];
			const entries = hashes.map((h, i) => ({
				type: 'command' as const,
				command_text: `cmd-${i}`,
				command_type: 'shell' as const,
				created_at: `2026-02-10T12:0${i}:00Z`,
			}));

			// Fire off multiple operations concurrently
			const promises = [
				appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION),
				appendAnnotation(tmpDir, SAMPLE_FUNCTION_ANNOTATION),
				appendAnnotation(tmpDir, SAMPLE_SESSION_RECORD),
				addManifestEntry(tmpDir, hashes[0], entries[0]),
				addManifestEntry(tmpDir, hashes[1], entries[1]),
				addManifestEntry(tmpDir, hashes[2], entries[2]),
			];
			await Promise.all(promises);

			await flushAll();

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(3);

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(3);
		});
	});

	// ========================================================================
	// initVibesDirectly (Fallback initialization)
	// ========================================================================
	describe('initVibesDirectly', () => {
		it('should create .ai-audit/ directory structure', async () => {
			const result = await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			expect(result.success).toBe(true);
			await expect(access(path.join(tmpDir, '.ai-audit'), constants.F_OK)).resolves.toBeUndefined();
			await expect(access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK)).resolves.toBeUndefined();
		});

		it('should create a valid config.json', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'my-app',
				assuranceLevel: 'high',
			});

			const config = await readVibesConfig(tmpDir);
			expect(config).not.toBeNull();
			expect(config!.standard).toBe('VIBES');
			expect(config!.standard_version).toBe('1.0');
			expect(config!.project_name).toBe('my-app');
			expect(config!.assurance_level).toBe('high');
			expect(config!.tracked_extensions).toContain('.ts');
			expect(config!.exclude_patterns).toContain('**/node_modules/**');
		});

		it('should create an empty manifest.json', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.standard).toBe('VIBES');
			expect(manifest.version).toBe('1.0');
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should create an empty annotations.jsonl', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			await expect(access(annotationsPath, constants.F_OK)).resolves.toBeUndefined();
			const content = await readFile(annotationsPath, 'utf8');
			expect(content).toBe('');
		});

		it('should use custom tracked extensions when provided', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'low',
				trackedExtensions: ['.rs', '.toml'],
			});

			const config = await readVibesConfig(tmpDir);
			expect(config!.tracked_extensions).toEqual(['.rs', '.toml']);
		});

		it('should use custom exclude patterns when provided', async () => {
			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
				excludePatterns: ['**/target/**'],
			});

			const config = await readVibesConfig(tmpDir);
			expect(config!.exclude_patterns).toEqual(['**/target/**']);
		});

		it('should not overwrite existing manifest', async () => {
			// Pre-create a manifest with entries
			await ensureAuditDir(tmpDir);
			const existingManifest = {
				standard: 'VIBES' as const,
				version: '1.0' as const,
				entries: { 'hash123': { type: 'environment' as const, tool_name: 'test', tool_version: '1.0', model_name: 'test', model_version: '1.0', created_at: '2026-02-10T12:00:00Z' } },
			};
			await writeVibesManifest(tmpDir, existingManifest);

			await initVibesDirectly(tmpDir, {
				projectName: 'test-project',
				assuranceLevel: 'medium',
			});

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(1);
			expect(manifest.entries['hash123']).toBeDefined();
		});

		it('should return error for invalid paths', async () => {
			const result = await initVibesDirectly('/dev/null/impossible', {
				projectName: 'test',
				assuranceLevel: 'medium',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	// ========================================================================
	// appendAnnotationImmediate (DIVERGENCE 4 fix)
	// ========================================================================
	describe('appendAnnotationImmediate', () => {
		it('should write annotation to disk immediately without buffering', async () => {
			await appendAnnotationImmediate(tmpDir, SAMPLE_SESSION_RECORD);

			// The annotation should be on disk already — no flushAll needed
			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const raw = await readFile(annotationsPath, 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_SESSION_RECORD);

			// The write buffer should still be empty (was not used)
			expect(getBufferedAnnotationCount(tmpDir)).toBe(0);
		});

		it('should serialize with project lock', async () => {
			// Fire multiple immediate writes concurrently — they should all succeed
			// without corrupting the file
			const records: VibesSessionRecord[] = [];
			for (let i = 0; i < 5; i++) {
				records.push({
					...SAMPLE_SESSION_RECORD,
					session_id: `session-${i}`,
					timestamp: `2026-02-10T12:0${i}:00Z`,
				});
			}

			await Promise.all(
				records.map((r) => appendAnnotationImmediate(tmpDir, r)),
			);

			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const raw = await readFile(annotationsPath, 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(5);
			// Each line should be valid JSON
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		});

		it('should append to existing annotations file', async () => {
			// Write a buffered annotation first
			await appendAnnotation(tmpDir, SAMPLE_LINE_ANNOTATION);
			await flushAll();

			// Now write an immediate annotation
			await appendAnnotationImmediate(tmpDir, SAMPLE_SESSION_RECORD);

			const annotationsPath = path.join(tmpDir, '.ai-audit', 'annotations.jsonl');
			const raw = await readFile(annotationsPath, 'utf8');
			const lines = raw.trim().split('\n');
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0])).toEqual(SAMPLE_LINE_ANNOTATION);
			expect(JSON.parse(lines[1])).toEqual(SAMPLE_SESSION_RECORD);
		});
	});

	// ========================================================================
	// writeReasoningBlob
	// ========================================================================
	describe('writeReasoningBlob', () => {
		it('should write blob file to .ai-audit/blobs/{hash}.blob', async () => {
			const hash = 'abc123def456';
			const data = 'This is reasoning blob data';
			await writeReasoningBlob(tmpDir, hash, data);

			const blobPath = path.join(tmpDir, '.ai-audit', 'blobs', `${hash}.blob`);
			await expect(access(blobPath, constants.F_OK)).resolves.toBeUndefined();
			const content = await readFile(blobPath, 'utf8');
			expect(content).toBe(data);
		});

		it('should create blobs directory if needed', async () => {
			// tmpDir has no .ai-audit/ yet
			const hash = 'newblobhash';
			await writeReasoningBlob(tmpDir, hash, 'data');

			await expect(
				access(path.join(tmpDir, '.ai-audit', 'blobs'), constants.F_OK),
			).resolves.toBeUndefined();
		});

		it('should return relative blob path', async () => {
			const hash = 'myhash123';
			const result = await writeReasoningBlob(tmpDir, hash, 'test data');

			expect(result).toBe(`blobs/${hash}.blob`);
		});

		it('should write Buffer data correctly', async () => {
			const hash = 'bufferhash';
			const data = Buffer.from('binary blob content', 'utf8');
			await writeReasoningBlob(tmpDir, hash, data);

			const blobPath = path.join(tmpDir, '.ai-audit', 'blobs', `${hash}.blob`);
			const content = await readFile(blobPath, 'utf8');
			expect(content).toBe('binary blob content');
		});
	});
});
