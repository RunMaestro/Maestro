import { describe, it, expect, vi } from 'vitest';
import { resolveTurnOutcome, type TurnFacts, type TurnOutcomeProvider } from '../turn-outcome';
import type { AgentError } from '../../../types';

function baseFacts(overrides: Partial<TurnFacts> = {}): TurnFacts {
	return {
		exitCode: 0,
		signal: null,
		interrupted: false,
		stderrText: '',
		stdoutText: '',
		explicitError: undefined,
		capturedAnswerText: undefined,
		resultMessageSeen: false,
		...overrides,
	};
}

function neverErrorsProvider(): TurnOutcomeProvider {
	return { detectErrorFromExit: vi.fn(() => null) };
}

function alwaysErrorsProvider(error: AgentError): TurnOutcomeProvider {
	return { detectErrorFromExit: vi.fn(() => error) };
}

const CLAUDE_CTX = { providerId: 'claude-code', sessionId: 'session-1' };
const OMP_CTX = { providerId: 'omp', sessionId: 'session-1' };

describe('resolveTurnOutcome', () => {
	it('reports completed for a clean exit with an explicit result and an answer', () => {
		const facts = baseFacts({ exitCode: 0, resultMessageSeen: true, capturedAnswerText: 'hello' });
		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);
		expect(result).toEqual({ outcome: 'completed' });
	});

	it('interrupted wins over everything else, including an explicit error and a flagged exit', () => {
		const explicitError: AgentError = {
			type: 'unknown',
			message: 'boom',
			recoverable: false,
			agentId: 'claude-code',
			timestamp: 0,
		};
		const provider = alwaysErrorsProvider(explicitError);
		const facts = baseFacts({
			interrupted: true,
			exitCode: 1,
			explicitError,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, provider, CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'interrupted' });
		// Short-circuits before the provider is even asked - a stopped turn is
		// never classified as a crash, and the provider call is skipped, not
		// just its result ignored.
		expect(provider.detectErrorFromExit).not.toHaveBeenCalled();
	});

	it('reports crashed and surfaces the error when explicitError is set', () => {
		const explicitError: AgentError = {
			type: 'rate_limited',
			message: 'rate limited',
			recoverable: true,
			agentId: 'codex',
			timestamp: 0,
		};
		const facts = baseFacts({ explicitError });

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'crashed', error: explicitError });
	});

	it('reports crashed and surfaces the error when detectErrorFromExit flags the exit', () => {
		const detected: AgentError = {
			type: 'agent_crashed',
			message: 'exit code 137',
			recoverable: false,
			agentId: 'grok',
			timestamp: 0,
		};
		const facts = baseFacts({ exitCode: 137 });

		const result = resolveTurnOutcome(facts, alwaysErrorsProvider(detected), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'crashed', error: detected });
	});

	it('passes exitCode 0 to detectErrorFromExit when exitCode is null (signal-killed)', () => {
		const provider = neverErrorsProvider();
		const facts = baseFacts({ exitCode: null, stderrText: 'stderr', stdoutText: 'stdout' });

		resolveTurnOutcome(facts, provider, CLAUDE_CTX);

		expect(provider.detectErrorFromExit).toHaveBeenCalledWith(0, 'stderr', 'stdout');
	});

	it('reports completed-with-warning for a non-zero exit with a captured answer (the CLI hasAnswer / Grok case)', () => {
		const facts = baseFacts({ exitCode: 1, capturedAnswerText: 'here is the answer' });

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'completed-with-warning' });
	});

	it('reports completed-with-warning for a clean exit with a captured answer but no explicit result event (Factory Droid no-done-event flush)', () => {
		const facts = baseFacts({
			exitCode: 0,
			resultMessageSeen: false,
			capturedAnswerText: 'streamed text',
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'completed-with-warning' });
	});

	it('reports crashed with no error payload for omp silently exiting clean with nothing captured', () => {
		const facts = baseFacts({
			exitCode: 0,
			resultMessageSeen: false,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), OMP_CTX);

		expect(result).toEqual({ outcome: 'crashed' });
	});

	it.each(['agent-terminal', 'session-synopsis-1', 'tab-naming-abc123'])(
		'does not apply the empty-answer rule to the excluded session shape %s even for omp',
		(sessionId) => {
			const facts = baseFacts({
				exitCode: 0,
				resultMessageSeen: false,
				capturedAnswerText: undefined,
			});

			const result = resolveTurnOutcome(facts, neverErrorsProvider(), {
				providerId: 'omp',
				sessionId,
			});

			expect(result).toEqual({ outcome: 'completed' });
		}
	);

	it('does not apply the empty-answer rule to non-omp providers by default (matches current production behavior)', () => {
		const facts = baseFacts({
			exitCode: 0,
			resultMessageSeen: false,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'completed' });
	});

	it('applies the empty-answer rule to every provider when generalizeEmptyAnswerRule is explicitly enabled', () => {
		const facts = baseFacts({
			exitCode: 0,
			resultMessageSeen: false,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX, {
			generalizeEmptyAnswerRule: true,
		});

		expect(result).toEqual({ outcome: 'crashed' });
	});

	it('still respects the session exclusions when the empty-answer rule is generalized', () => {
		const facts = baseFacts({
			exitCode: 0,
			resultMessageSeen: false,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(
			facts,
			neverErrorsProvider(),
			{ providerId: 'claude-code', sessionId: 'x-synopsis-9' },
			{ generalizeEmptyAnswerRule: true }
		);

		expect(result).toEqual({ outcome: 'completed' });
	});

	it('treats an empty captured answer string the same as undefined', () => {
		const facts = baseFacts({ exitCode: 0, resultMessageSeen: false, capturedAnswerText: '   ' });

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), OMP_CTX);

		expect(result).toEqual({ outcome: 'crashed' });
	});
});
