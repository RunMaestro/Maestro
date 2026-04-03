/**
 * OpenClaw Output Parser — Smoke test with real CLI output
 *
 * Verifies the parser correctly handles actual OpenClaw --json output
 * captured from: openclaw agent --agent main --local --json --message "..."
 */
import { describe, it, expect } from 'vitest';
import { OpenClawOutputParser } from '../../../main/parsers/openclaw-output-parser';

const parser = new OpenClawOutputParser();

// Real output captured from openclaw agent --agent main --local --json
const REAL_OPENCLAW_OUTPUT = {
	payloads: [{ text: 'Hello there, how are you?', mediaUrl: null }],
	meta: {
		durationMs: 6845,
		agentMeta: {
			sessionId: 'e491f1ca-c469-4e23-9144-5068d30f55f3',
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			usage: { input: 3, output: 10, cacheWrite: 212719, total: 212732 },
			lastCallUsage: {
				input: 3,
				output: 10,
				cacheRead: 0,
				cacheWrite: 212719,
				total: 212732,
			},
		},
	},
};

describe('OpenClaw Output Parser — real output', () => {
	it('should parse real JSON object into result event', () => {
		const event = parser.parseJsonObject(REAL_OPENCLAW_OUTPUT);
		expect(event).not.toBeNull();
		expect(event!.type).toBe('result');
		expect(event!.text).toBe('Hello there, how are you?');
		expect(event!.sessionId).toBe('e491f1ca-c469-4e23-9144-5068d30f55f3');
	});

	it('should parse real JSON line (stringified)', () => {
		const line = JSON.stringify(REAL_OPENCLAW_OUTPUT);
		const event = parser.parseJsonLine(line);
		expect(event).not.toBeNull();
		expect(event!.type).toBe('result');
		expect(event!.text).toBe('Hello there, how are you?');
	});

	it('should correctly extract usage stats', () => {
		const event = parser.parseJsonObject(REAL_OPENCLAW_OUTPUT);
		const usage = parser.extractUsage(event!);
		expect(usage).not.toBeNull();
		expect(usage!.inputTokens).toBe(3);
		expect(usage!.outputTokens).toBe(10);
		expect(usage!.cacheCreationTokens).toBe(212719);
		// cacheRead=0 becomes undefined because 0 is falsy (|| undefined in parser)
		expect(usage!.cacheReadTokens).toBeUndefined();
	});

	it('should extract sessionId', () => {
		const event = parser.parseJsonObject(REAL_OPENCLAW_OUTPUT);
		expect(parser.extractSessionId(event!)).toBe('e491f1ca-c469-4e23-9144-5068d30f55f3');
	});

	it('should identify result messages', () => {
		const event = parser.parseJsonObject(REAL_OPENCLAW_OUTPUT);
		expect(parser.isResultMessage(event!)).toBe(true);
	});

	it('should ignore ANSI-colored stderr debug lines', () => {
		const stderrLines = [
			'\x1b[33m[agent/embedded]\x1b[39m \x1b[33membedded run agent end\x1b[39m',
			'\x1b[33m[agent/embedded]\x1b[39m \x1b[33mauth profile failure state updated\x1b[39m',
			'',
		];
		for (const line of stderrLines) {
			expect(parser.parseJsonLine(line)).toBeNull();
		}
	});

	it('should return null for exit code 0', () => {
		expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
	});

	it('should detect gateway auth error from stderr', () => {
		const error = parser.detectErrorFromExit(1, 'gateway auth failed', '');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('auth_expired');
		expect(error!.agentId).toBe('openclaw');
	});

	it('should detect generic exit error', () => {
		const error = parser.detectErrorFromExit(1, '', '');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('agent_crashed');
		expect(error!.recoverable).toBe(true);
	});

	it('should detect rate limit errors', () => {
		const error = parser.detectErrorFromLine('Error: rate limit exceeded');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('rate_limited');
	});

	it('should detect network errors', () => {
		const error = parser.detectErrorFromLine('ECONNREFUSED');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('network_error');
	});

	it('should detect session not found errors', () => {
		const error = parser.detectErrorFromLine('Error: session not found');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('session_not_found');
	});

	it('should detect SYSTEM_RUN_DENIED permission error', () => {
		const error = parser.detectErrorFromLine('SYSTEM_RUN_DENIED: /usr/bin/rm');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('permission_denied');
		expect(error!.recoverable).toBe(false);
	});

	it('should detect OpenClaw-specific error: agent not found', () => {
		const error = parser.detectErrorFromLine('Error: agent not found: nonexistent');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('agent_crashed');
	});

	it('should detect OpenClaw-specific error: worker offline', () => {
		const error = parser.detectErrorFromLine('node macmini2 offline');
		expect(error).not.toBeNull();
		expect(error!.type).toBe('agent_crashed');
	});

	it('should detect error from parsed JSON error event', () => {
		const error = parser.detectErrorFromParsed({
			type: 'error',
			message: 'Something went wrong',
		});
		expect(error).not.toBeNull();
		expect(error!.type).toBe('agent_crashed');
		expect(error!.message).toBe('Something went wrong');
	});

	it('should handle multi-payload responses', () => {
		const multiPayload = {
			payloads: [
				{ text: 'First part', mediaUrl: null },
				{ text: 'Second part', mediaUrl: null },
			],
			meta: {
				durationMs: 1000,
				agentMeta: {
					sessionId: 'test-session',
					provider: 'anthropic',
					model: 'claude-sonnet-4-6',
					usage: { input: 1, output: 2, total: 3 },
				},
			},
		};
		const event = parser.parseJsonObject(multiPayload);
		expect(event!.text).toBe('First part\nSecond part');
	});

	it('should return null for slash commands (unsupported)', () => {
		const event = parser.parseJsonObject(REAL_OPENCLAW_OUTPUT);
		expect(parser.extractSlashCommands(event!)).toBeNull();
	});
});
