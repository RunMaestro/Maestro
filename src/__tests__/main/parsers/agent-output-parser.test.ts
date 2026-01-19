import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	registerOutputParser,
	getOutputParser,
	hasOutputParser,
	getAllOutputParsers,
	clearParserRegistry,
	isValidToolType,
	type AgentOutputParser,
	type ParsedEvent,
} from '../../../main/parsers/agent-output-parser';
import type { ToolType } from '../../../shared/types';

// Mock parser for testing - fully implements AgentOutputParser interface
class MockParser implements AgentOutputParser {
	readonly agentId: ToolType = 'terminal';

	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) return null;
		try {
			const data = JSON.parse(line);
			return {
				type: 'text',
				text: data.text || '',
				raw: data,
			};
		} catch {
			return null;
		}
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	extractSlashCommands(event: ParsedEvent): string[] | null {
		return event.slashCommands || null;
	}

	detectErrorFromLine(_line: string): null {
		// Mock implementation - always returns null (no error detected)
		return null;
	}

	detectErrorFromExit(_exitCode: number, _stderr: string, _stdout: string): null {
		// Mock implementation - always returns null (no error detected)
		return null;
	}
}

describe('agent-output-parser', () => {
	beforeEach(() => {
		clearParserRegistry();
	});

	afterEach(() => {
		clearParserRegistry();
	});

	describe('ParsedEvent interface', () => {
		it('should support all event types', () => {
			const eventTypes: ParsedEvent['type'][] = [
				'init',
				'text',
				'tool_use',
				'result',
				'error',
				'usage',
				'system',
			];

			eventTypes.forEach((type) => {
				const event: ParsedEvent = { type, raw: {} };
				expect(event.type).toBe(type);
			});
		});

		it('should support optional fields', () => {
			const fullEvent: ParsedEvent = {
				type: 'result',
				sessionId: 'session-123',
				text: 'Hello world',
				toolName: 'bash',
				toolState: { running: true },
				usage: {
					inputTokens: 100,
					outputTokens: 200,
					cacheReadTokens: 50,
					cacheCreationTokens: 10,
					contextWindow: 200000,
					costUsd: 0.05,
				},
				slashCommands: ['/help', '/clear'],
				isPartial: false,
				raw: { type: 'result' },
			};

			expect(fullEvent.sessionId).toBe('session-123');
			expect(fullEvent.text).toBe('Hello world');
			expect(fullEvent.toolName).toBe('bash');
			expect(fullEvent.usage?.inputTokens).toBe(100);
			expect(fullEvent.slashCommands).toContain('/help');
		});

		it('should allow minimal event with just type and raw', () => {
			const minimalEvent: ParsedEvent = {
				type: 'system',
				raw: {},
			};

			expect(minimalEvent.type).toBe('system');
			expect(minimalEvent.sessionId).toBeUndefined();
			expect(minimalEvent.text).toBeUndefined();
		});
	});

	describe('registerOutputParser', () => {
		it('should register a parser', () => {
			const parser = new MockParser();
			registerOutputParser(parser);

			expect(hasOutputParser('terminal')).toBe(true);
		});

		it('should allow registering multiple parsers', () => {
			const parser1 = new MockParser();
			registerOutputParser(parser1);

			// Create another mock with different agentId
			const parser2: AgentOutputParser = {
				agentId: 'claude-code' as ToolType,
				parseJsonLine: () => null,
				isResultMessage: () => false,
				extractSessionId: () => null,
				extractUsage: () => null,
				extractSlashCommands: () => null,
				detectErrorFromLine: () => null,
				detectErrorFromExit: () => null,
			};
			registerOutputParser(parser2);

			expect(hasOutputParser('terminal')).toBe(true);
			expect(hasOutputParser('claude-code')).toBe(true);
		});

		it('should overwrite existing parser for same agentId', () => {
			const parser1 = new MockParser();
			registerOutputParser(parser1);

			const parser2 = new MockParser();
			registerOutputParser(parser2);

			expect(getAllOutputParsers().length).toBe(1);
		});
	});

	describe('getOutputParser', () => {
		it('should return registered parser', () => {
			const parser = new MockParser();
			registerOutputParser(parser);

			const retrieved = getOutputParser('terminal');
			expect(retrieved).toBe(parser);
		});

		it('should return null for unregistered agent', () => {
			const retrieved = getOutputParser('unknown-agent');
			expect(retrieved).toBeNull();
		});

		it('should accept string type for agentId', () => {
			const parser = new MockParser();
			registerOutputParser(parser);

			const retrieved = getOutputParser('terminal' as string);
			expect(retrieved).toBe(parser);
		});
	});

	describe('hasOutputParser', () => {
		it('should return true for registered parser', () => {
			const parser = new MockParser();
			registerOutputParser(parser);

			expect(hasOutputParser('terminal')).toBe(true);
		});

		it('should return false for unregistered agent', () => {
			expect(hasOutputParser('unknown-agent')).toBe(false);
		});
	});

	describe('getAllOutputParsers', () => {
		it('should return empty array when no parsers registered', () => {
			expect(getAllOutputParsers()).toEqual([]);
		});

		it('should return all registered parsers', () => {
			const parser1 = new MockParser();
			registerOutputParser(parser1);

			const parser2: AgentOutputParser = {
				agentId: 'claude-code' as ToolType,
				parseJsonLine: () => null,
				isResultMessage: () => false,
				extractSessionId: () => null,
				extractUsage: () => null,
				extractSlashCommands: () => null,
				detectErrorFromLine: () => null,
				detectErrorFromExit: () => null,
			};
			registerOutputParser(parser2);

			const all = getAllOutputParsers();
			expect(all.length).toBe(2);
		});
	});

	describe('clearParserRegistry', () => {
		it('should remove all registered parsers', () => {
			const parser = new MockParser();
			registerOutputParser(parser);

			expect(hasOutputParser('terminal')).toBe(true);

			clearParserRegistry();

			expect(hasOutputParser('terminal')).toBe(false);
			expect(getAllOutputParsers()).toEqual([]);
		});
	});

	describe('AgentOutputParser interface implementation', () => {
		it('should correctly implement parseJsonLine', () => {
			const parser = new MockParser();
			registerOutputParser(parser);

			const event = parser.parseJsonLine('{"text":"Hello"}');
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('Hello');
		});

		it('should return null for empty lines', () => {
			const parser = new MockParser();
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
		});

		it('should return null for invalid JSON', () => {
			const parser = new MockParser();
			expect(parser.parseJsonLine('not json')).toBeNull();
		});

		it('should correctly implement isResultMessage', () => {
			const parser = new MockParser();

			const resultEvent: ParsedEvent = { type: 'result', raw: {} };
			const textEvent: ParsedEvent = { type: 'text', raw: {} };

			expect(parser.isResultMessage(resultEvent)).toBe(true);
			expect(parser.isResultMessage(textEvent)).toBe(false);
		});

		it('should correctly implement extractSessionId', () => {
			const parser = new MockParser();

			const eventWithSession: ParsedEvent = { type: 'init', sessionId: 'sess-123', raw: {} };
			const eventWithoutSession: ParsedEvent = { type: 'text', raw: {} };

			expect(parser.extractSessionId(eventWithSession)).toBe('sess-123');
			expect(parser.extractSessionId(eventWithoutSession)).toBeNull();
		});

		it('should correctly implement extractUsage', () => {
			const parser = new MockParser();

			const eventWithUsage: ParsedEvent = {
				type: 'usage',
				usage: { inputTokens: 100, outputTokens: 50 },
				raw: {},
			};
			const eventWithoutUsage: ParsedEvent = { type: 'text', raw: {} };

			expect(parser.extractUsage(eventWithUsage)).toEqual({ inputTokens: 100, outputTokens: 50 });
			expect(parser.extractUsage(eventWithoutUsage)).toBeNull();
		});

		it('should correctly implement extractSlashCommands', () => {
			const parser = new MockParser();

			const eventWithCommands: ParsedEvent = {
				type: 'init',
				slashCommands: ['/help', '/clear'],
				raw: {},
			};
			const eventWithoutCommands: ParsedEvent = { type: 'text', raw: {} };

			expect(parser.extractSlashCommands(eventWithCommands)).toEqual(['/help', '/clear']);
			expect(parser.extractSlashCommands(eventWithoutCommands)).toBeNull();
		});
	});

	describe('isValidToolType', () => {
		it('should return true for valid ToolType values', () => {
			expect(isValidToolType('claude-code')).toBe(true);
			expect(isValidToolType('opencode')).toBe(true);
			expect(isValidToolType('codex')).toBe(true);
			expect(isValidToolType('terminal')).toBe(true);
			expect(isValidToolType('claude')).toBe(true);
			expect(isValidToolType('aider')).toBe(true);
		});

		it('should return false for invalid agent IDs', () => {
			expect(isValidToolType('unknown-agent')).toBe(false);
			expect(isValidToolType('')).toBe(false);
			expect(isValidToolType('random-string')).toBe(false);
			expect(isValidToolType('CLAUDE-CODE')).toBe(false); // case sensitive
		});
	});

	describe('type guard integration with getOutputParser', () => {
		it('should return null for invalid agent IDs', () => {
			expect(getOutputParser('invalid-agent-id')).toBeNull();
		});

		it('should work correctly for valid but unregistered agent IDs', () => {
			// Valid ToolType but no parser registered
			expect(getOutputParser('claude-code')).toBeNull();
		});
	});
});
