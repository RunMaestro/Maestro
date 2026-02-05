/**
 * Tests for src/main/process-manager/handlers/StderrHandler.ts
 *
 * Covers stderr handling including:
 * - SSH informational message filtering
 * - Codex stdin mode response extraction
 * - Error detection from stderr
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/terminalFilter', () => ({
	stripAllAnsiCodes: vi.fn((str: string) => str),
}));

vi.mock('../../../../main/parsers/error-patterns', () => ({
	matchSshErrorPattern: vi.fn(() => null),
}));

vi.mock('../../../../main/process-manager/utils/bufferUtils', () => ({
	appendToBuffer: vi.fn((buf: string, data: string) => buf + data),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { StderrHandler } from '../../../../main/process-manager/handlers/StderrHandler';
import type { ManagedProcess } from '../../../../main/process-manager/types';

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: 'test-session',
		toolType: 'claude-code',
		cwd: '/tmp',
		pid: 1234,
		isTerminal: false,
		startTime: Date.now(),
		stderrBuffer: '',
		errorEmitted: false,
		...overrides,
	} as ManagedProcess;
}

function createTestContext(processOverrides: Partial<ManagedProcess> = {}) {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const sessionId = 'test-session';
	const proc = createMockProcess({ sessionId, ...processOverrides });
	processes.set(sessionId, proc);

	const handler = new StderrHandler({ processes, emitter });

	return { processes, emitter, handler, sessionId, proc };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('StderrHandler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('SSH informational message filtering', () => {
		it('should suppress "Pseudo-terminal will not be allocated" message', () => {
			const { handler, emitter, sessionId } = createTestContext();

			const stderrSpy = vi.fn();
			emitter.on('stderr', stderrSpy);

			handler.handleData(
				sessionId,
				'Pseudo-terminal will not be allocated because stdin is not a terminal.'
			);

			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('should suppress SSH known hosts warning', () => {
			const { handler, emitter, sessionId } = createTestContext();

			const stderrSpy = vi.fn();
			emitter.on('stderr', stderrSpy);

			handler.handleData(
				sessionId,
				'Warning: Permanently added "example.com" to the list of known hosts.'
			);

			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('should emit other stderr messages normally', () => {
			const { handler, emitter, sessionId } = createTestContext();

			const stderrSpy = vi.fn();
			emitter.on('stderr', stderrSpy);

			handler.handleData(sessionId, 'Some error message');

			expect(stderrSpy).toHaveBeenCalledWith(sessionId, 'Some error message');
		});
	});

	describe('Codex stdin mode response extraction', () => {
		it('should extract response from "Reading prompt from stdin..." prefix', () => {
			const { handler, emitter, sessionId } = createTestContext({
				toolType: 'codex',
			});

			const dataSpy = vi.fn();
			const stderrSpy = vi.fn();
			emitter.on('data', dataSpy);
			emitter.on('stderr', stderrSpy);

			handler.handleData(sessionId, 'Reading prompt from stdin...Hello! How can I help you?');

			// Should emit as data, not stderr
			expect(dataSpy).toHaveBeenCalledWith(sessionId, 'Hello! How can I help you?');
			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('should handle "Reading prompt from stdin..." with no content after', () => {
			const { handler, emitter, sessionId } = createTestContext({
				toolType: 'codex',
			});

			const dataSpy = vi.fn();
			const stderrSpy = vi.fn();
			emitter.on('data', dataSpy);
			emitter.on('stderr', stderrSpy);

			handler.handleData(sessionId, 'Reading prompt from stdin...');

			// No actual content to emit
			expect(dataSpy).not.toHaveBeenCalled();
			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('should NOT filter "Reading prompt from stdin..." for non-Codex agents', () => {
			const { handler, emitter, sessionId } = createTestContext({
				toolType: 'claude-code',
			});

			const stderrSpy = vi.fn();
			emitter.on('stderr', stderrSpy);

			handler.handleData(sessionId, 'Reading prompt from stdin...some message');

			// Should emit as stderr for non-Codex agents
			expect(stderrSpy).toHaveBeenCalledWith(sessionId, 'Reading prompt from stdin...some message');
		});
	});

	describe('empty and whitespace handling', () => {
		it('should not emit empty stderr', () => {
			const { handler, emitter, sessionId } = createTestContext();

			const stderrSpy = vi.fn();
			emitter.on('stderr', stderrSpy);

			handler.handleData(sessionId, '');

			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('should not emit whitespace-only stderr', () => {
			const { handler, emitter, sessionId } = createTestContext();

			const stderrSpy = vi.fn();
			emitter.on('stderr', stderrSpy);

			handler.handleData(sessionId, '   \n\t  ');

			expect(stderrSpy).not.toHaveBeenCalled();
		});
	});

	describe('stderr buffer accumulation', () => {
		it('should accumulate stderr in buffer', () => {
			const { handler, sessionId, proc } = createTestContext();

			handler.handleData(sessionId, 'Error 1\n');
			handler.handleData(sessionId, 'Error 2\n');

			// Buffer should contain both errors
			expect(proc.stderrBuffer).toContain('Error 1');
			expect(proc.stderrBuffer).toContain('Error 2');
		});
	});
});
