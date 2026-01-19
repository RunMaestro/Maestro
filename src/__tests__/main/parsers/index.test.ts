import { describe, it, expect, beforeEach } from 'vitest';
import {
	initializeOutputParsers,
	ensureParsersInitialized,
	getOutputParser,
	hasOutputParser,
	getAllOutputParsers,
	clearParserRegistry,
	ClaudeOutputParser,
	OpenCodeOutputParser,
	CodexOutputParser,
} from '../../../main/parsers';

describe('parsers/index', () => {
	beforeEach(() => {
		clearParserRegistry();
	});

	describe('initializeOutputParsers', () => {
		it('should register Claude parser', () => {
			expect(hasOutputParser('claude-code')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('claude-code')).toBe(true);
		});

		it('should register OpenCode parser', () => {
			expect(hasOutputParser('opencode')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('opencode')).toBe(true);
		});

		it('should register Codex parser', () => {
			expect(hasOutputParser('codex')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('codex')).toBe(true);
		});

		it('should register exactly 3 parsers', () => {
			initializeOutputParsers();

			const parsers = getAllOutputParsers();
			expect(parsers.length).toBe(3);
		});

		it('should clear existing parsers before registering', () => {
			// First initialization
			initializeOutputParsers();
			expect(getAllOutputParsers().length).toBe(3);

			// Second initialization should still have exactly 3
			initializeOutputParsers();
			expect(getAllOutputParsers().length).toBe(3);
		});
	});

	describe('ensureParsersInitialized', () => {
		it('should initialize parsers on first call', () => {
			expect(getAllOutputParsers().length).toBe(0);

			ensureParsersInitialized();

			expect(getAllOutputParsers().length).toBe(3);
		});

		it('should be idempotent after first call', () => {
			ensureParsersInitialized();
			const first = getAllOutputParsers();

			ensureParsersInitialized();
			const second = getAllOutputParsers();

			expect(first.length).toBe(second.length);
		});
	});

	describe('getOutputParser', () => {
		beforeEach(() => {
			initializeOutputParsers();
		});

		it('should return ClaudeOutputParser for claude-code', () => {
			const parser = getOutputParser('claude-code');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(ClaudeOutputParser);
		});

		it('should return OpenCodeOutputParser for opencode', () => {
			const parser = getOutputParser('opencode');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(OpenCodeOutputParser);
		});

		it('should return CodexOutputParser for codex', () => {
			const parser = getOutputParser('codex');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(CodexOutputParser);
		});

		it('should return null for terminal', () => {
			const parser = getOutputParser('terminal');
			expect(parser).toBeNull();
		});

		it('should return null for unknown agents', () => {
			const parser = getOutputParser('unknown');
			expect(parser).toBeNull();
		});
	});

	describe('parser exports', () => {
		it('should export ClaudeOutputParser class', () => {
			const parser = new ClaudeOutputParser();
			expect(parser.agentId).toBe('claude-code');
		});

		it('should export OpenCodeOutputParser class', () => {
			const parser = new OpenCodeOutputParser();
			expect(parser.agentId).toBe('opencode');
		});

		it('should export CodexOutputParser class', () => {
			const parser = new CodexOutputParser();
			expect(parser.agentId).toBe('codex');
		});
	});

	describe('integration', () => {
		it('should correctly parse Claude output after initialization', () => {
			initializeOutputParsers();

			const parser = getOutputParser('claude-code');
			const event = parser?.parseJsonLine(
				JSON.stringify({ type: 'result', result: 'Hello', session_id: 'sess-123' })
			);

			expect(event?.type).toBe('result');
			expect(event?.text).toBe('Hello');
			expect(event?.sessionId).toBe('sess-123');
		});

		it('should correctly parse OpenCode output after initialization', () => {
			initializeOutputParsers();

			const parser = getOutputParser('opencode');
			// OpenCode step_finish format uses part.reason to determine result vs system
			const event = parser?.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'oc-123', part: { reason: 'stop' } })
			);

			expect(event?.type).toBe('result');
			expect(event?.sessionId).toBe('oc-123');
		});

		it('should correctly parse Codex output after initialization', () => {
			initializeOutputParsers();

			const parser = getOutputParser('codex');
			// Codex uses thread.started for session initialization with thread_id
			const event = parser?.parseJsonLine(
				JSON.stringify({ type: 'thread.started', thread_id: 'cdx-456' })
			);

			expect(event?.type).toBe('init');
			expect(event?.sessionId).toBe('cdx-456');
		});
	});
});
