/**
 * Turn result adapter - maps maestro-lib TurnFacts onto the CLI's AgentResult.
 *
 * The first block pins the adapter's own rules with a stub provider. The
 * second block runs the REAL exit classifier of every provider against a
 * "bad exit with a usable answer" turn, since that is the one shape the CLI's
 * old ad hoc rules and the library's resolver could disagree on.
 */

import { describe, it, expect } from 'vitest';
import {
	resolveCliTurnResult,
	interruptedResult,
	spawnFailureResult,
	type CliTurnInput,
} from '../../../cli/services/turn-result';
import { createOutputParser } from '../../../shared/maestro-lib/parsers/parser-factory';
import type { ToolType, UsageStats } from '../../../shared/types';

const neverFlags = { detectErrorFromExit: () => null };

function input(overrides: Partial<CliTurnInput> = {}): CliTurnInput {
	return {
		toolType: 'claude-code',
		provider: neverFlags,
		exitCode: 0,
		signal: null,
		interrupted: false,
		stderrText: '',
		stdoutText: '',
		answerText: 'the answer',
		resultMessageSeen: true,
		strictEmptyAnswer: false,
		answerOutranksBareExit: true,
		...overrides,
	};
}

const usage: UsageStats = {
	inputTokens: 10,
	outputTokens: 5,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0.01,
	contextWindow: 200000,
};

describe('resolveCliTurnResult', () => {
	it('reports a clean exit with an explicit done signal as completed', () => {
		const result = resolveCliTurnResult(input());
		expect(result).toMatchObject({ success: true, outcome: 'completed', response: 'the answer' });
	});

	it('keeps a usable answer after a non-zero exit as a success with a warning outcome', () => {
		const result = resolveCliTurnResult(input({ exitCode: 1, resultMessageSeen: false }));
		expect(result).toMatchObject({
			success: true,
			outcome: 'completed-with-warning',
			response: 'the answer',
		});
	});

	it('fails a non-zero exit that produced no answer even when nothing else flagged it', () => {
		const result = resolveCliTurnResult(
			input({
				exitCode: 3,
				answerText: undefined,
				resultMessageSeen: false,
				stderrText: 'boom',
			})
		);
		expect(result).toMatchObject({ success: false, outcome: 'crashed', error: 'boom' });
	});

	it('lets an interrupt win over an answer and an in-band error', () => {
		const result = resolveCliTurnResult(
			input({ interrupted: true, exitCode: 1, errorText: 'late error' })
		);
		expect(result).toMatchObject({ success: false, outcome: 'interrupted' });
		expect(result.error).toMatch(/interrupted/i);
	});

	it('reports an in-band error as crashed and prefers its text', () => {
		const result = resolveCliTurnResult(
			input({ errorText: 'rate limited', stderrText: 'noise', exitCode: 0 })
		);
		expect(result).toMatchObject({ success: false, outcome: 'crashed', error: 'rate limited' });
	});

	it('treats a signal-killed turn with nothing captured as crashed', () => {
		const result = resolveCliTurnResult(
			input({
				exitCode: null,
				signal: 'SIGKILL',
				answerText: undefined,
				resultMessageSeen: false,
			})
		);
		expect(result.success).toBe(false);
		expect(result.outcome).toBe('crashed');
		expect(result.error).toMatch(/SIGKILL/);
	});

	it('fails a clean exit with no answer only when strictEmptyAnswer is set', () => {
		const empty = { answerText: undefined, resultMessageSeen: false };
		expect(resolveCliTurnResult(input({ ...empty, strictEmptyAnswer: true }))).toMatchObject({
			success: false,
			outcome: 'crashed',
		});
		expect(resolveCliTurnResult(input({ ...empty, strictEmptyAnswer: false }))).toMatchObject({
			success: true,
			outcome: 'completed',
		});
	});

	it('fails a clean exit whose only answer was dropped by the line-buffer cap', () => {
		// The path that accepts an empty clean exit is exactly the one the cap can
		// silently empty, so without this the turn reports completed with no response.
		const result = resolveCliTurnResult(
			input({
				answerText: undefined,
				resultMessageSeen: false,
				strictEmptyAnswer: false,
				droppedOutputBytes: 2 * 1024 * 1024,
			})
		);
		expect(result).toMatchObject({ success: false, outcome: 'crashed' });
		expect(result.error).toMatch(/2097152 bytes of output were discarded/);
	});

	it('keeps a captured answer even when some earlier output was dropped', () => {
		expect(resolveCliTurnResult(input({ droppedOutputBytes: 2 * 1024 * 1024 }))).toMatchObject({
			success: true,
			outcome: 'completed',
			response: 'the answer',
		});
	});

	const classifiedAs = (type: 'agent_crashed' | 'rate_limited', message: string) => ({
		detectErrorFromExit: () => ({
			type,
			message,
			recoverable: false,
			agentId: 'claude-code',
			timestamp: 0,
		}),
	});
	const noAnswer = { answerText: undefined, resultMessageSeen: false };

	it('surfaces a specific provider classification as the error when nothing else explains a crash', () => {
		const result = resolveCliTurnResult(
			input({
				provider: classifiedAs('rate_limited', 'Rate limit reached'),
				exitCode: 2,
				...noAnswer,
			})
		);
		expect(result).toMatchObject({
			success: false,
			outcome: 'crashed',
			error: 'Rate limit reached',
		});
	});

	it('does not let the generic agent_crashed fallback replace the exit-code wording', () => {
		const result = resolveCliTurnResult(
			input({
				provider: classifiedAs('agent_crashed', 'Agent exited with code 2'),
				exitCode: 2,
				...noAnswer,
			})
		);
		expect(result.error).toBe('Process exited with code 2');
	});

	it('lets a captured answer outrank the generic agent_crashed fallback', () => {
		const result = resolveCliTurnResult(
			input({
				provider: classifiedAs('agent_crashed', 'Agent exited with code 1'),
				exitCode: 1,
				resultMessageSeen: false,
			})
		);
		expect(result).toMatchObject({ success: true, outcome: 'completed-with-warning' });
	});

	it('still fails a turn with a specific classification even when an answer was captured', () => {
		const result = resolveCliTurnResult(
			input({
				provider: classifiedAs('rate_limited', 'Rate limit reached'),
				exitCode: 1,
				resultMessageSeen: false,
			})
		);
		expect(result).toMatchObject({
			success: false,
			outcome: 'crashed',
			error: 'Rate limit reached',
		});
	});

	it('does not let an answer outrank an in-band error the provider reported', () => {
		const result = resolveCliTurnResult(
			input({
				provider: classifiedAs('agent_crashed', 'Agent exited with code 1'),
				exitCode: 1,
				errorText: 'tool exploded',
				resultMessageSeen: false,
			})
		);
		expect(result).toMatchObject({ success: false, outcome: 'crashed', error: 'tool exploded' });
	});

	describe('review findings', () => {
		const generic = {
			detectErrorFromExit: () => ({
				type: 'agent_crashed' as const,
				message: 'Agent exited with code 1',
				recoverable: true,
				agentId: 'x',
				timestamp: 0,
			}),
		};

		it('does not let an answer outrank a PATTERN-classified agent_crashed (panic, fatal error, ...)', () => {
			// The error bank has agent_crashed patterns of its own; only the
			// unmatched "exited with code N" fallback may be outranked.
			const provider = {
				detectErrorFromExit: () => ({
					type: 'agent_crashed' as const,
					message: 'The agent hit an unexpected internal error',
					recoverable: false,
					agentId: 'x',
					timestamp: 0,
				}),
			};
			const result = resolveCliTurnResult(
				input({ provider, exitCode: 1, resultMessageSeen: false })
			);
			expect(result).toMatchObject({ success: false, outcome: 'crashed' });
		});

		it('keeps a bad exit fatal when the caller opts out of the leniency (the Claude path)', () => {
			const result = resolveCliTurnResult(
				input({
					provider: generic,
					exitCode: 1,
					resultMessageSeen: false,
					answerOutranksBareExit: false,
				})
			);
			expect(result).toMatchObject({ success: false, outcome: 'crashed' });
		});

		it('never reports success for a process killed by a signal nobody requested, answer or not', () => {
			for (const answerOutranksBareExit of [true, false]) {
				const result = resolveCliTurnResult(
					input({
						exitCode: null,
						signal: 'SIGKILL',
						resultMessageSeen: false,
						answerOutranksBareExit,
					})
				);
				expect(result).toMatchObject({ success: false, outcome: 'crashed' });
				expect(result.error).toContain('SIGKILL');
			}
		});

		it('fails a clean exit with an EMPTY result event when strictEmptyAnswer is set', () => {
			const result = resolveCliTurnResult(
				input({ answerText: undefined, resultMessageSeen: true, strictEmptyAnswer: true })
			);
			expect(result).toMatchObject({ success: false, outcome: 'crashed' });
		});

		it('still accepts a clean exit with an empty result event when strictEmptyAnswer is not set', () => {
			const result = resolveCliTurnResult(
				input({ answerText: undefined, resultMessageSeen: true, strictEmptyAnswer: false })
			);
			expect(result).toMatchObject({ success: true, outcome: 'completed' });
		});

		it('classifies a bad exit that produced an answer from stderr only, never from the answer text', () => {
			const parser = createOutputParser('grok');
			if (!parser) throw new Error('grok parser missing');
			const answerMentioningAuth = 'The service hit a rate limit, so I added retries.';
			// Precondition, so this test cannot pass vacuously: the same text DOES
			// classify as a specific error when the classifier is allowed to see it.
			expect(parser.detectErrorFromExit(1, '', answerMentioningAuth)?.type).not.toBe(
				'agent_crashed'
			);

			const result = resolveCliTurnResult(
				input({
					toolType: 'grok',
					provider: parser,
					exitCode: 1,
					stderrText: '',
					stdoutText: answerMentioningAuth,
					answerText: answerMentioningAuth,
					resultMessageSeen: false,
				})
			);
			expect(result).toMatchObject({ success: true, outcome: 'completed-with-warning' });
		});

		it('still reads stdout when nothing was captured, so a stdout-only failure is not lost', () => {
			const parser = createOutputParser('grok');
			if (!parser) throw new Error('grok parser missing');
			const result = resolveCliTurnResult(
				input({
					toolType: 'grok',
					provider: parser,
					exitCode: 1,
					stderrText: '',
					stdoutText: 'Error: rate limit exceeded',
					answerText: undefined,
					resultMessageSeen: false,
				})
			);
			expect(result).toMatchObject({ success: false, outcome: 'crashed' });
			expect(result.error).not.toBe('Process exited with code 1');
		});
	});

	it('carries the session id and usage through every outcome', () => {
		const base = { agentSessionId: 'sess-1', usageStats: usage };
		for (const overrides of [
			{},
			{ exitCode: 1, resultMessageSeen: false },
			{ interrupted: true },
			{ errorText: 'x' },
		]) {
			const result = resolveCliTurnResult(input({ ...base, ...overrides }));
			expect(result.agentSessionId).toBe('sess-1');
			expect(result.usageStats).toBe(usage);
		}
	});

	it('falls back to a generic message when a crash has no text at all', () => {
		const result = resolveCliTurnResult(
			input({ exitCode: 9, answerText: undefined, resultMessageSeen: false })
		);
		expect(result.error).toBe('Process exited with code 9');
	});
});

describe('interruptedResult / spawnFailureResult', () => {
	it('builds an interrupted result without a process ever running', () => {
		expect(interruptedResult()).toMatchObject({ success: false, outcome: 'interrupted' });
	});

	it('builds a crashed result for a failure to start', () => {
		expect(spawnFailureResult('Failed to spawn X: ENOENT')).toEqual({
			success: false,
			outcome: 'crashed',
			error: 'Failed to spawn X: ENOENT',
		});
	});
});

describe('bad-exit-with-answer across real providers', () => {
	// Providers that speak JSON lines through the generic CLI spawner, plus Claude.
	const providers: ToolType[] = [
		'claude-code',
		'codex',
		'opencode',
		'factory-droid',
		'grok',
		'copilot-cli',
		'omp',
		'pi',
		'qwen3-coder',
		'antigravity',
	];

	for (const toolType of providers) {
		it(`${toolType}: a non-zero exit with a real answer and empty stderr is not a crash`, () => {
			const parser = createOutputParser(toolType);
			if (!parser) return; // provider has no parser registered in this build
			const result = resolveCliTurnResult(
				input({
					toolType,
					provider: parser,
					exitCode: 1,
					stderrText: '',
					stdoutText: '{"type":"result","result":"the answer"}\n',
					resultMessageSeen: false,
				})
			);
			expect(result.success).toBe(true);
			expect(result.outcome).toBe('completed-with-warning');
		});
	}
});
