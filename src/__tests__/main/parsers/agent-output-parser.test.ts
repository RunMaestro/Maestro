import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	registerOutputParser,
	getOutputParser,
	hasOutputParser,
	getAllOutputParsers,
	clearParserRegistry,
	type AgentOutputParser,
	type ParsedEvent,
} from '../../../main/parsers/agent-output-parser';
import type { ToolType, UsageAccounting, UsageCost, UsageStats } from '../../../shared/types';
import { GrokOutputParser } from '../../../shared/maestro-lib/parsers/grok-output-parser';
import { ClaudeOutputParser } from '../../../shared/maestro-lib/parsers/claude-output-parser';
import { CodexOutputParser } from '../../../shared/maestro-lib/parsers/codex-output-parser';

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

	describe('shared terminal and accounting serialization', () => {
		// Synthetic normalized events, not native Grok protocol fixtures. Consumer
		// accumulation and parsedUsageToStats propagation are tested by their consumers.
		const accounting: UsageAccounting = {
			source: 'runtime-stream',
			route: 'acp',
			scope: 'turn',
			reporting: 'snapshot',
			scopeId: 'fixture-account-host',
			providerSessionId: 'native-session-1',
			processGeneration: 'process-2',
			turnId: 'turn-3',
			requestId: 4,
			responseId: 'response-5',
			cacheReadCounting: 'inside-input',
			cacheCreationCounting: 'inside-input',
			completeness: 'partial',
			cost: { status: 'unknown', reason: 'No cost reported' },
			childInclusion: 'completed',
			childCompleteness: 'partial',
		};

		it('retains incomplete terminal usage, occupancy and model/child scopes at extraction', () => {
			const event: ParsedEvent = {
				type: 'result',
				sessionId: 'native-session-1',
				text: 'Partial answer',
				terminal: {
					status: 'incomplete',
					kind: 'limit',
					providerStopReason: 'max_tokens',
					dispatchState: 'dispatched',
				},
				usage: {
					inputTokens: 130,
					outputTokens: 30,
					cacheReadTokens: 20,
					cacheCreationTokens: 10,
					reasoningTokens: 5,
					absoluteUsage: {
						inputTokens: 50,
						outputTokens: 10,
						cacheReadInputTokens: 5,
						cacheCreationInputTokens: 2,
						reasoningTokens: 3,
					},
					accounting: {
						...accounting,
						final: true,
						cost: { status: 'partial', costUsdTicks: '17', reason: 'Child still running' },
						estimatedCost: {
							status: 'estimated',
							costUsd: 0.02,
							model: 'fixture-model',
							pricingRevision: 'fixture-pricing-v1',
							completeness: 'partial',
						},
						callCount: 3,
						mainAgentRounds: 2,
						models: [
							{
								model: 'fixture-model',
								inputTokens: 100,
								outputTokens: 20,
								completeness: 'partial',
								cost: { status: 'partial', costUsdTicks: '17' },
							},
						],
						children: [
							{
								providerSessionId: 'child-1',
								parentToolUseId: 'tool-1',
								status: 'completed',
								includedInParent: true,
								inputTokens: 20,
								outputTokens: 10,
								completeness: 'complete',
								cost: { status: 'exact', costUsdTicks: '0' },
							},
							{
								providerSessionId: 'child-2',
								parentToolUseId: 'tool-2',
								status: 'running',
								includedInParent: false,
								inputTokens: 10,
								completeness: 'partial',
								cost: { status: 'unknown' },
							},
						],
					},
				},
				raw: {},
			};
			const restored: ParsedEvent = JSON.parse(JSON.stringify(event));
			const parser = new GrokOutputParser();

			expect(restored).toStrictEqual(event);
			expect(parser.extractUsage(restored)).toStrictEqual(event.usage);
			expect(parser.extractSessionId(restored)).toBe('native-session-1');
			expect(restored.terminal).toStrictEqual(event.terminal);
			expect(restored.usage?.accounting?.final).toBe(true);
			expect(restored.usage?.accounting?.completeness).toBe('partial');
			expect(restored.usage).not.toHaveProperty('costUsd');
		});

		it.each(['9007199254740993', '9007199254740993123456789'])(
			'preserves exact decimal ticks %s beyond safe integer precision',
			(costUsdTicks) => {
				const event: ParsedEvent = {
					type: 'usage',
					usage: {
						inputTokens: 10,
						outputTokens: 2,
						accounting: { ...accounting, cost: { status: 'exact', costUsdTicks } },
					},
					raw: {},
				};
				const restored: ParsedEvent = JSON.parse(JSON.stringify(event));
				const extracted = new GrokOutputParser().extractUsage(restored);
				expect(Number.isSafeInteger(Number(costUsdTicks))).toBe(false);
				expect(extracted).toStrictEqual(event.usage);
				expect(extracted?.accounting?.cost).toStrictEqual({ status: 'exact', costUsdTicks });
				if (extracted?.accounting?.cost.status !== 'exact') throw new Error('Lost exact cost');
				expect(typeof extracted.accounting.cost.costUsdTicks).toBe('string');
				expect(extracted).not.toHaveProperty('costUsd');
			}
		);

		it.each<[string, UsageCost, number | undefined]>([
			['unknown', { status: 'unknown', reason: 'No cost reported' }, undefined],
			['authoritative zero', { status: 'exact', costUsd: 0, costUsdTicks: '0' }, 0],
			['partial without amount', { status: 'partial', reason: 'Interrupted ledger' }, undefined],
			['partial zero', { status: 'partial', costUsdTicks: '0' }, undefined],
			[
				'estimate',
				{
					status: 'estimated',
					costUsd: 0.25,
					model: 'fixture-model',
					pricingRevision: 'fixture-pricing-v1',
					completeness: 'unknown',
				},
				undefined,
			],
		])('keeps %s distinct from complete free usage', (_label, cost, costUsd) => {
			const event: ParsedEvent = {
				type: 'usage',
				usage: {
					inputTokens: 10,
					outputTokens: 2,
					...(costUsd === undefined ? {} : { costUsd }),
					accounting: { ...accounting, cost },
				},
				raw: {},
			};
			const restored: ParsedEvent = JSON.parse(JSON.stringify(event));
			const extracted = new GrokOutputParser().extractUsage(restored);
			expect(extracted).toStrictEqual(event.usage);
			expect(extracted?.accounting?.cost).toStrictEqual(cost);
			if (costUsd === undefined) expect(extracted).not.toHaveProperty('costUsd');
			else expect(extracted).toHaveProperty('costUsd', 0);
		});

		it.each<UsageAccounting['scope']>([
			'response',
			'turn',
			'process-session',
			'native-session',
			'child',
		])('preserves %s accounting independently of legacy cost and occupancy', (scope) => {
			const stats: UsageStats = {
				inputTokens: 130,
				outputTokens: 30,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 10,
				totalCostUsd: 0,
				contextWindow: 200_000,
				accounting: { ...accounting, scope },
				absoluteUsage: {
					inputTokens: 50,
					outputTokens: 10,
					cacheReadInputTokens: 5,
					cacheCreationInputTokens: 2,
					reasoningTokens: 3,
				},
			};
			const restored: UsageStats = JSON.parse(JSON.stringify(stats));
			expect(restored).toStrictEqual(stats);
			expect(restored.accounting?.cost.status).toBe('unknown');
			expect(restored.totalCostUsd).toBe(0);
			expect(restored.accounting?.scope).toBe(scope);
		});

		it.each([new ClaudeOutputParser(), new CodexOutputParser()])(
			'keeps legacy $agentId normalized events free of invented metadata',
			(parser) => {
				const event: ParsedEvent = {
					type: 'result',
					sessionId: 'legacy-session',
					text: 'Finished',
					usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
					raw: {},
				};
				const restored: ParsedEvent = JSON.parse(JSON.stringify(event));
				const extracted = parser.extractUsage(restored);
				expect(restored).toStrictEqual(event);
				expect(extracted).toStrictEqual(event.usage);
				expect(restored).not.toHaveProperty('terminal');
				expect(extracted).not.toHaveProperty('accounting');
				expect(extracted).not.toHaveProperty('costUsd');
				expect(parser.extractSessionId(restored)).toBe('legacy-session');
			}
		);
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
