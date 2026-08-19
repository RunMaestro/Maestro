import { describe, it, expect, beforeEach } from 'vitest';
import {
	initializeOutputParsers,
	getOutputParser,
	hasOutputParser,
	getAllOutputParsers,
	clearParserRegistry,
	ClaudeOutputParser,
	OpenCodeOutputParser,
	CodexOutputParser,
	CopilotOutputParser,
	PiOutputParser,
	OmpOutputParser,
	QwenOutputParser,
	GrokOutputParser,
	CursorCliOutputParser,
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

		it('should register Factory Droid parser', () => {
			expect(hasOutputParser('factory-droid')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('factory-droid')).toBe(true);
		});

		it('should register Copilot parser', () => {
			expect(hasOutputParser('copilot-cli')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('copilot-cli')).toBe(true);
		});

		it('should register Pi parser', () => {
			expect(hasOutputParser('pi')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('pi')).toBe(true);
		});

		it('should register Qwen parser', () => {
			expect(hasOutputParser('qwen3-coder')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('qwen3-coder')).toBe(true);
		});

		it('should register Omp parser', () => {
			expect(hasOutputParser('omp')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('omp')).toBe(true);
		});

		it('should register Grok parser', () => {
			expect(hasOutputParser('grok')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('grok')).toBe(true);
		});

		it('should register Cursor CLI parser', () => {
			expect(hasOutputParser('cursor-cli')).toBe(false);

			initializeOutputParsers();

			expect(hasOutputParser('cursor-cli')).toBe(true);
		});

		it('should register exactly 10 parsers', () => {
			initializeOutputParsers();

			const parsers = getAllOutputParsers();
			expect(parsers.length).toBe(10);
		});

		it('should clear existing parsers before registering', () => {
			// First initialization
			initializeOutputParsers();
			expect(getAllOutputParsers().length).toBe(10);

			// Second initialization should still have exactly 10
			initializeOutputParsers();
			expect(getAllOutputParsers().length).toBe(10);
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

		it('should return CopilotOutputParser for copilot', () => {
			const parser = getOutputParser('copilot-cli');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(CopilotOutputParser);
		});

		it('should return PiOutputParser for pi', () => {
			const parser = getOutputParser('pi');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(PiOutputParser);
		});

		it('should return OmpOutputParser for omp', () => {
			const parser = getOutputParser('omp');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(OmpOutputParser);
		});
		it('should return QwenOutputParser for qwen3-coder', () => {
			const parser = getOutputParser('qwen3-coder');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(QwenOutputParser);
		});

		it('should return GrokOutputParser for grok', () => {
			const parser = getOutputParser('grok');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(GrokOutputParser);
		});

		it('should return CursorCliOutputParser for cursor-cli', () => {
			const parser = getOutputParser('cursor-cli');
			expect(parser).not.toBeNull();
			expect(parser).toBeInstanceOf(CursorCliOutputParser);
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

		it('should export CopilotOutputParser class', () => {
			const parser = new CopilotOutputParser();
			expect(parser.agentId).toBe('copilot-cli');
		});

		it('should export PiOutputParser class', () => {
			const parser = new PiOutputParser();
			expect(parser.agentId).toBe('pi');
		});

		it('should export OmpOutputParser class', () => {
			const parser = new OmpOutputParser();
			expect(parser.agentId).toBe('omp');
		});
		it('should export QwenOutputParser class', () => {
			const parser = new QwenOutputParser();
			expect(parser.agentId).toBe('qwen3-coder');
		});

		it('should export GrokOutputParser class', () => {
			const parser = new GrokOutputParser();
			expect(parser.agentId).toBe('grok');
		});

		it('should export CursorCliOutputParser class', () => {
			const parser = new CursorCliOutputParser();
			expect(parser.agentId).toBe('cursor-cli');
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
			// step_finish always emits 'system' (usage stats only); result text comes from 'text' events
			const event = parser?.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'oc-123', part: { reason: 'stop' } })
			);

			expect(event?.type).toBe('system');
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
