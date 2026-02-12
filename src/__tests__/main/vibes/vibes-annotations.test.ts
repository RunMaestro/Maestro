/**
 * Tests for src/main/vibes/vibes-annotations.ts
 * Validates the VIBES annotation builder functions: environment, command,
 * prompt, reasoning entries, line annotations, and session records.
 */

import { gunzipSync } from 'zlib';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createEnvironmentEntry,
	createCommandEntry,
	createPromptEntry,
	createReasoningEntry,
	createExternalReasoningEntry,
	createLineAnnotation,
	createFunctionAnnotation,
	createSessionRecord,
} from '../../../main/vibes/vibes-annotations';

describe('vibes-annotations', () => {
	// Freeze time so timestamp assertions are deterministic
	const FIXED_ISO = '2026-02-10T12:00:00.000Z';

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ========================================================================
	// createEnvironmentEntry
	// ========================================================================
	describe('createEnvironmentEntry', () => {
		it('should create a valid environment entry with required fields', () => {
			const { entry, hash } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.2.3',
				modelName: 'claude-4',
				modelVersion: 'opus',
			});

			expect(entry.type).toBe('environment');
			expect(entry.tool_name).toBe('Claude Code');
			expect(entry.tool_version).toBe('1.2.3');
			expect(entry.model_name).toBe('claude-4');
			expect(entry.model_version).toBe('opus');
			expect(entry.created_at).toBe(FIXED_ISO);
			expect(entry.model_parameters).toBeUndefined();
			expect(entry.tool_extensions).toBeUndefined();
		});

		it('should include optional modelParameters when provided', () => {
			const { entry } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0',
				modelName: 'claude-4',
				modelVersion: 'opus',
				modelParameters: { temperature: 0.7, top_p: 0.9 },
			});

			expect(entry.model_parameters).toEqual({ temperature: 0.7, top_p: 0.9 });
		});

		it('should include optional toolExtensions when provided', () => {
			const { entry } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0',
				modelName: 'claude-4',
				modelVersion: 'opus',
				toolExtensions: ['mcp-server', 'memory'],
			});

			expect(entry.tool_extensions).toEqual(['mcp-server', 'memory']);
		});

		it('should return a valid 64-char hex hash', () => {
			const { hash } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0',
				modelName: 'claude-4',
				modelVersion: 'opus',
			});

			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should produce the same hash for same content regardless of created_at', () => {
			const result1 = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0',
				modelName: 'claude-4',
				modelVersion: 'opus',
			});

			vi.setSystemTime(new Date('2026-12-31T23:59:59.000Z'));

			const result2 = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0',
				modelName: 'claude-4',
				modelVersion: 'opus',
			});

			expect(result1.hash).toBe(result2.hash);
			expect(result1.entry.created_at).not.toBe(result2.entry.created_at);
		});

		it('should produce different hashes for different content', () => {
			const { hash: hash1 } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0',
				modelName: 'claude-4',
				modelVersion: 'opus',
			});

			const { hash: hash2 } = createEnvironmentEntry({
				toolName: 'Codex',
				toolVersion: '1.0',
				modelName: 'o3',
				modelVersion: 'latest',
			});

			expect(hash1).not.toBe(hash2);
		});
	});

	// ========================================================================
	// createCommandEntry
	// ========================================================================
	describe('createCommandEntry', () => {
		it('should create a valid command entry with required fields', () => {
			const { entry, hash } = createCommandEntry({
				commandText: 'npm test',
				commandType: 'shell',
			});

			expect(entry.type).toBe('command');
			expect(entry.command_text).toBe('npm test');
			expect(entry.command_type).toBe('shell');
			expect(entry.created_at).toBe(FIXED_ISO);
			expect(entry.command_exit_code).toBeUndefined();
			expect(entry.command_output_summary).toBeUndefined();
			expect(entry.working_directory).toBeUndefined();
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should include optional exitCode', () => {
			const { entry } = createCommandEntry({
				commandText: 'npm test',
				commandType: 'shell',
				exitCode: 0,
			});

			expect(entry.command_exit_code).toBe(0);
		});

		it('should include optional outputSummary', () => {
			const { entry } = createCommandEntry({
				commandText: 'cat file.ts',
				commandType: 'file_read',
				outputSummary: 'Read 42 lines from file.ts',
			});

			expect(entry.command_output_summary).toBe('Read 42 lines from file.ts');
		});

		it('should include optional workingDirectory', () => {
			const { entry } = createCommandEntry({
				commandText: 'ls -la',
				commandType: 'shell',
				workingDirectory: '/home/user/project',
			});

			expect(entry.working_directory).toBe('/home/user/project');
		});

		it('should include all optional fields when provided', () => {
			const { entry } = createCommandEntry({
				commandText: 'git commit -m "fix"',
				commandType: 'shell',
				exitCode: 0,
				outputSummary: '1 file changed',
				workingDirectory: '/project',
			});

			expect(entry.command_exit_code).toBe(0);
			expect(entry.command_output_summary).toBe('1 file changed');
			expect(entry.working_directory).toBe('/project');
		});

		it('should handle exit code 0 correctly (not treated as falsy)', () => {
			const { entry } = createCommandEntry({
				commandText: 'true',
				commandType: 'shell',
				exitCode: 0,
			});

			expect(entry.command_exit_code).toBe(0);
		});

		it('should support all command types', () => {
			const types: Array<'shell' | 'file_write' | 'file_read' | 'file_delete' | 'api_call' | 'tool_use' | 'other'> = [
				'shell', 'file_write', 'file_read', 'file_delete', 'api_call', 'tool_use', 'other',
			];

			for (const commandType of types) {
				const { entry } = createCommandEntry({
					commandText: 'test',
					commandType,
				});
				expect(entry.command_type).toBe(commandType);
			}
		});
	});

	// ========================================================================
	// createPromptEntry
	// ========================================================================
	describe('createPromptEntry', () => {
		it('should create a valid prompt entry with required fields', () => {
			const { entry, hash } = createPromptEntry({
				promptText: 'Fix the authentication bug in login.ts',
			});

			expect(entry.type).toBe('prompt');
			expect(entry.prompt_text).toBe('Fix the authentication bug in login.ts');
			expect(entry.created_at).toBe(FIXED_ISO);
			expect(entry.prompt_type).toBeUndefined();
			expect(entry.prompt_context_files).toBeUndefined();
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should include optional promptType', () => {
			const { entry } = createPromptEntry({
				promptText: 'Refactor this function',
				promptType: 'refactor_request',
			});

			expect(entry.prompt_type).toBe('refactor_request');
		});

		it('should include optional contextFiles', () => {
			const { entry } = createPromptEntry({
				promptText: 'Update these files',
				contextFiles: ['src/main.ts', 'src/utils.ts'],
			});

			expect(entry.prompt_context_files).toEqual(['src/main.ts', 'src/utils.ts']);
		});

		it('should produce the same hash for identical prompt text', () => {
			const { hash: hash1 } = createPromptEntry({ promptText: 'Fix this' });

			vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

			const { hash: hash2 } = createPromptEntry({ promptText: 'Fix this' });

			expect(hash1).toBe(hash2);
		});
	});

	// ========================================================================
	// createReasoningEntry
	// ========================================================================
	describe('createReasoningEntry', () => {
		it('should create a valid reasoning entry with required fields', () => {
			const { entry, hash } = createReasoningEntry({
				reasoningText: 'The function needs a null check because...',
			});

			expect(entry.type).toBe('reasoning');
			expect(entry.reasoning_text).toBe('The function needs a null check because...');
			expect(entry.created_at).toBe(FIXED_ISO);
			expect(entry.reasoning_token_count).toBeUndefined();
			expect(entry.reasoning_model).toBeUndefined();
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should include optional tokenCount', () => {
			const { entry } = createReasoningEntry({
				reasoningText: 'Thinking...',
				tokenCount: 512,
			});

			expect(entry.reasoning_token_count).toBe(512);
		});

		it('should include optional model', () => {
			const { entry } = createReasoningEntry({
				reasoningText: 'Analysis...',
				model: 'claude-4-opus',
			});

			expect(entry.reasoning_model).toBe('claude-4-opus');
		});

		it('should produce different hashes for different reasoning text', () => {
			const { hash: hash1 } = createReasoningEntry({ reasoningText: 'Approach A' });
			const { hash: hash2 } = createReasoningEntry({ reasoningText: 'Approach B' });

			expect(hash1).not.toBe(hash2);
		});

		it('stores raw reasoning_text when below compress threshold', () => {
			const shortText = 'Short reasoning text under threshold';
			const { entry } = createReasoningEntry({ reasoningText: shortText });

			expect(entry.reasoning_text).toBe(shortText);
			expect(entry.reasoning_text_compressed).toBeUndefined();
			expect(entry.compressed).toBeUndefined();
		});

		it('compresses reasoning_text when above compress threshold', () => {
			// Create text exceeding the default 10 KB threshold
			const largeText = 'A'.repeat(11000);
			const { entry } = createReasoningEntry({ reasoningText: largeText });

			expect(entry.reasoning_text_compressed).toBeDefined();
			expect(typeof entry.reasoning_text_compressed).toBe('string');
			// Compressed base64 should be shorter than the raw text
			expect(entry.reasoning_text_compressed!.length).toBeLessThan(largeText.length);
		});

		it('sets compressed flag to true when compressed', () => {
			const largeText = 'B'.repeat(11000);
			const { entry } = createReasoningEntry({ reasoningText: largeText });

			expect(entry.compressed).toBe(true);
		});

		it('omits raw reasoning_text when compressed', () => {
			const largeText = 'C'.repeat(11000);
			const { entry } = createReasoningEntry({ reasoningText: largeText });

			expect(entry.reasoning_text).toBeUndefined();
		});

		it('compressed text can be decompressed back to original via gunzipSync + base64 decode', () => {
			const originalText = 'D'.repeat(11000);
			const { entry } = createReasoningEntry({ reasoningText: originalText });

			expect(entry.reasoning_text_compressed).toBeDefined();

			// Decode base64 → gunzip → UTF-8 string
			const compressedBuf = Buffer.from(entry.reasoning_text_compressed!, 'base64');
			const decompressed = gunzipSync(compressedBuf).toString('utf8');

			expect(decompressed).toBe(originalText);
		});

		it('respects custom compressThresholdBytes parameter', () => {
			const text = 'E'.repeat(500); // 500 bytes

			// Below custom threshold of 1000 — should not compress
			const { entry: belowEntry } = createReasoningEntry({
				reasoningText: text,
				compressThresholdBytes: 1000,
			});
			expect(belowEntry.reasoning_text).toBe(text);
			expect(belowEntry.compressed).toBeUndefined();

			// Above custom threshold of 100 — should compress
			const { entry: aboveEntry } = createReasoningEntry({
				reasoningText: text,
				compressThresholdBytes: 100,
			});
			expect(aboveEntry.compressed).toBe(true);
			expect(aboveEntry.reasoning_text).toBeUndefined();
		});
	});

	// ========================================================================
	// createExternalReasoningEntry
	// ========================================================================
	describe('createExternalReasoningEntry', () => {
		it('should create external reasoning entry with blob_path', () => {
			const { entry, hash } = createExternalReasoningEntry({
				blobPath: 'blobs/abc123.blob',
			});

			expect(entry.type).toBe('reasoning');
			expect(entry.blob_path).toBe('blobs/abc123.blob');
			expect(entry.external).toBe(true);
			expect(entry.created_at).toBe(FIXED_ISO);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should set external flag to true for external entries', () => {
			const { entry } = createExternalReasoningEntry({
				blobPath: 'blobs/def456.blob',
			});

			expect(entry.external).toBe(true);
		});

		it('should omit reasoning_text for external entries', () => {
			const { entry } = createExternalReasoningEntry({
				blobPath: 'blobs/ghi789.blob',
			});

			expect(entry.reasoning_text).toBeUndefined();
			expect(entry.reasoning_text_compressed).toBeUndefined();
			expect(entry.compressed).toBeUndefined();
		});

		it('should include optional tokenCount', () => {
			const { entry } = createExternalReasoningEntry({
				blobPath: 'blobs/test.blob',
				tokenCount: 5000,
			});

			expect(entry.reasoning_token_count).toBe(5000);
		});

		it('should include optional model', () => {
			const { entry } = createExternalReasoningEntry({
				blobPath: 'blobs/test.blob',
				model: 'claude-4-opus',
			});

			expect(entry.reasoning_model).toBe('claude-4-opus');
		});

		it('should produce different hashes for different blob paths', () => {
			const { hash: hash1 } = createExternalReasoningEntry({ blobPath: 'blobs/a.blob' });
			const { hash: hash2 } = createExternalReasoningEntry({ blobPath: 'blobs/b.blob' });

			expect(hash1).not.toBe(hash2);
		});
	});

	// ========================================================================
	// createLineAnnotation
	// ========================================================================
	describe('createLineAnnotation', () => {
		it('should create a valid line annotation with required fields', () => {
			const annotation = createLineAnnotation({
				filePath: 'src/main.ts',
				lineStart: 10,
				lineEnd: 20,
				environmentHash: 'a'.repeat(64),
				action: 'create',
				assuranceLevel: 'medium',
			});

			expect(annotation.type).toBe('line');
			expect(annotation.file_path).toBe('src/main.ts');
			expect(annotation.line_start).toBe(10);
			expect(annotation.line_end).toBe(20);
			expect(annotation.environment_hash).toBe('a'.repeat(64));
			expect(annotation.action).toBe('create');
			expect(annotation.timestamp).toBe(FIXED_ISO);
			expect(annotation.assurance_level).toBe('medium');
			expect(annotation.command_hash).toBeUndefined();
			expect(annotation.prompt_hash).toBeUndefined();
			expect(annotation.reasoning_hash).toBeUndefined();
			expect(annotation.session_id).toBeUndefined();
			expect(annotation.commit_hash).toBeUndefined();
		});

		it('should include all optional hash references', () => {
			const annotation = createLineAnnotation({
				filePath: 'src/main.ts',
				lineStart: 1,
				lineEnd: 5,
				environmentHash: 'e'.repeat(64),
				commandHash: 'c'.repeat(64),
				promptHash: 'p'.repeat(64),
				reasoningHash: 'r'.repeat(64),
				action: 'modify',
				assuranceLevel: 'high',
			});

			expect(annotation.command_hash).toBe('c'.repeat(64));
			expect(annotation.prompt_hash).toBe('p'.repeat(64));
			expect(annotation.reasoning_hash).toBe('r'.repeat(64));
		});

		it('should include optional sessionId and commitHash', () => {
			const annotation = createLineAnnotation({
				filePath: 'src/main.ts',
				lineStart: 1,
				lineEnd: 1,
				environmentHash: 'e'.repeat(64),
				action: 'review',
				sessionId: 'session-123',
				commitHash: 'abc1234',
				assuranceLevel: 'low',
			});

			expect(annotation.session_id).toBe('session-123');
			expect(annotation.commit_hash).toBe('abc1234');
		});

		it('should support all action types', () => {
			const actions: Array<'create' | 'modify' | 'delete' | 'review'> = [
				'create', 'modify', 'delete', 'review',
			];

			for (const action of actions) {
				const annotation = createLineAnnotation({
					filePath: 'test.ts',
					lineStart: 1,
					lineEnd: 1,
					environmentHash: 'e'.repeat(64),
					action,
					assuranceLevel: 'low',
				});
				expect(annotation.action).toBe(action);
			}
		});

		it('should support all assurance levels', () => {
			const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];

			for (const assuranceLevel of levels) {
				const annotation = createLineAnnotation({
					filePath: 'test.ts',
					lineStart: 1,
					lineEnd: 1,
					environmentHash: 'e'.repeat(64),
					action: 'create',
					assuranceLevel,
				});
				expect(annotation.assurance_level).toBe(assuranceLevel);
			}
		});
	});

	// ========================================================================
	// createFunctionAnnotation
	// ========================================================================
	describe('createFunctionAnnotation', () => {
		it('creates function annotation with required fields', () => {
			const annotation = createFunctionAnnotation({
				filePath: 'src/utils.ts',
				functionName: 'calculateTotal',
				environmentHash: 'a'.repeat(64),
				action: 'create',
				assuranceLevel: 'medium',
			});

			expect(annotation.type).toBe('function');
			expect(annotation.file_path).toBe('src/utils.ts');
			expect(annotation.function_name).toBe('calculateTotal');
			expect(annotation.environment_hash).toBe('a'.repeat(64));
			expect(annotation.action).toBe('create');
			expect(annotation.assurance_level).toBe('medium');
			expect(annotation.function_signature).toBeUndefined();
			expect(annotation.command_hash).toBeUndefined();
			expect(annotation.prompt_hash).toBeUndefined();
			expect(annotation.reasoning_hash).toBeUndefined();
			expect(annotation.session_id).toBeUndefined();
			expect(annotation.commit_hash).toBeUndefined();
		});

		it('includes optional fields when provided', () => {
			const annotation = createFunctionAnnotation({
				filePath: 'src/auth.ts',
				functionName: 'authenticate',
				functionSignature: 'authenticate(user: string, pass: string): Promise<boolean>',
				environmentHash: 'e'.repeat(64),
				commandHash: 'c'.repeat(64),
				promptHash: 'p'.repeat(64),
				reasoningHash: 'r'.repeat(64),
				action: 'modify',
				sessionId: 'session-456',
				commitHash: 'def5678',
				assuranceLevel: 'high',
			});

			expect(annotation.function_signature).toBe(
				'authenticate(user: string, pass: string): Promise<boolean>',
			);
			expect(annotation.command_hash).toBe('c'.repeat(64));
			expect(annotation.prompt_hash).toBe('p'.repeat(64));
			expect(annotation.reasoning_hash).toBe('r'.repeat(64));
			expect(annotation.session_id).toBe('session-456');
			expect(annotation.commit_hash).toBe('def5678');
		});

		it('sets type to function', () => {
			const annotation = createFunctionAnnotation({
				filePath: 'src/index.ts',
				functionName: 'main',
				environmentHash: 'e'.repeat(64),
				action: 'create',
				assuranceLevel: 'low',
			});

			expect(annotation.type).toBe('function');
		});

		it('sets timestamp to ISO string', () => {
			const annotation = createFunctionAnnotation({
				filePath: 'src/index.ts',
				functionName: 'init',
				environmentHash: 'e'.repeat(64),
				action: 'create',
				assuranceLevel: 'low',
			});

			expect(annotation.timestamp).toBe(FIXED_ISO);
		});
	});

	// ========================================================================
	// createSessionRecord
	// ========================================================================
	describe('createSessionRecord', () => {
		it('should create a valid session start record', () => {
			const record = createSessionRecord({
				event: 'start',
				sessionId: 'session-abc-123',
			});

			expect(record.type).toBe('session');
			expect(record.event).toBe('start');
			expect(record.session_id).toBe('session-abc-123');
			expect(record.timestamp).toBe(FIXED_ISO);
			expect(record.environment_hash).toBeUndefined();
			expect(record.assurance_level).toBeUndefined();
			expect(record.description).toBeUndefined();
		});

		it('should create a valid session end record', () => {
			const record = createSessionRecord({
				event: 'end',
				sessionId: 'session-abc-123',
			});

			expect(record.event).toBe('end');
		});

		it('should include optional environmentHash', () => {
			const record = createSessionRecord({
				event: 'start',
				sessionId: 'session-xyz',
				environmentHash: 'e'.repeat(64),
			});

			expect(record.environment_hash).toBe('e'.repeat(64));
		});

		it('should include optional assuranceLevel', () => {
			const record = createSessionRecord({
				event: 'start',
				sessionId: 'session-xyz',
				assuranceLevel: 'high',
			});

			expect(record.assurance_level).toBe('high');
		});

		it('should include optional description', () => {
			const record = createSessionRecord({
				event: 'start',
				sessionId: 'session-xyz',
				description: 'Claude Code agent session for project refactoring',
			});

			expect(record.description).toBe('Claude Code agent session for project refactoring');
		});

		it('should include all optional fields when provided', () => {
			const record = createSessionRecord({
				event: 'start',
				sessionId: 'session-full',
				environmentHash: 'e'.repeat(64),
				assuranceLevel: 'medium',
				description: 'Full session record',
			});

			expect(record.environment_hash).toBe('e'.repeat(64));
			expect(record.assurance_level).toBe('medium');
			expect(record.description).toBe('Full session record');
		});
	});

	// ========================================================================
	// Integration: entries work with vibes-hash
	// ========================================================================
	describe('hash integration', () => {
		it('should produce consistent hashes across entry types', () => {
			const { hash: envHash } = createEnvironmentEntry({
				toolName: 'test',
				toolVersion: '1.0',
				modelName: 'test',
				modelVersion: '1.0',
			});
			const { hash: cmdHash } = createCommandEntry({
				commandText: 'test',
				commandType: 'shell',
			});
			const { hash: promptHash } = createPromptEntry({
				promptText: 'test',
			});
			const { hash: reasonHash } = createReasoningEntry({
				reasoningText: 'test',
			});

			// All hashes should be valid 64-char hex strings
			for (const hash of [envHash, cmdHash, promptHash, reasonHash]) {
				expect(hash).toMatch(/^[0-9a-f]{64}$/);
			}

			// Different entry types should produce different hashes (different fields)
			const hashes = new Set([envHash, cmdHash, promptHash, reasonHash]);
			expect(hashes.size).toBe(4);
		});

		it('should produce hashes usable as line annotation references', () => {
			const { hash: envHash } = createEnvironmentEntry({
				toolName: 'Claude Code',
				toolVersion: '1.0',
				modelName: 'claude-4',
				modelVersion: 'opus',
			});
			const { hash: cmdHash } = createCommandEntry({
				commandText: 'echo hello',
				commandType: 'shell',
			});

			const annotation = createLineAnnotation({
				filePath: 'src/index.ts',
				lineStart: 1,
				lineEnd: 10,
				environmentHash: envHash,
				commandHash: cmdHash,
				action: 'create',
				assuranceLevel: 'medium',
			});

			expect(annotation.environment_hash).toBe(envHash);
			expect(annotation.command_hash).toBe(cmdHash);
		});
	});
});
