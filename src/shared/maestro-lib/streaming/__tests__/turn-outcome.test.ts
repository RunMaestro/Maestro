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

	it('does NOT misclassify omp as crashed when a result was already seen, even with nothing in capturedAnswerText', () => {
		// Regression test: the empty-answer rule must require !resultMessageSeen,
		// not just !hasAnswer. A provider that already delivered its result
		// through the normal path (resultEmitted true) must never be
		// reclassified as a crash just because capturedAnswerText - a separate,
		// best-effort streamed-text accumulator - happens to be empty at exit.
		const facts = baseFacts({
			exitCode: 0,
			resultMessageSeen: true,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), OMP_CTX);

		expect(result).toEqual({ outcome: 'completed' });
	});

	it('reports crashed for a signal-terminated exit with no answer and no result, for ANY provider (not omp-scoped)', () => {
		// Regression test: exitCode ?? 0 coerces a signal-killed process's null
		// exit code to 0 before calling detectErrorFromExit, and every
		// provider's detectErrorFromExit treats exit code 0 as success. Without
		// this rule, a signal-killed turn with nothing captured would fall
		// through to `completed`, reporting an abnormal termination as success.
		const facts = baseFacts({
			exitCode: null,
			signal: 'SIGKILL',
			resultMessageSeen: false,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'crashed' });
	});

	// A clean exit reports no signal, but not always as `null`: node-pty types
	// its own field `signal?: number` (node-pty.d.ts:156) and `PtySpawner.ts:251`
	// forwards it untouched, so `undefined` arrives here, and some platforms
	// report 0. A `!== null` check reads each as a kill, which bypasses the omp
	// gate for every provider and reports an ordinary empty turn as crashed.
	// The outcome is pinned rather than merely asserted not-crashed, so a rule
	// change that sends these somewhere else is caught too.
	it.each<[string, TurnFacts['signal']]>([
		['undefined, as a clean node-pty exit reports it', undefined],
		['0, as some platforms report on a normal exit', 0],
		["'', which no signal name can be", ''],
	])('completes a clean empty turn whose signal is %s', (_shape, signal) => {
		const facts = baseFacts({
			exitCode: 0,
			signal,
			resultMessageSeen: false,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'completed' });
	});

	it('does not flag a signal-terminated exit as crashed when a result was already seen', () => {
		const facts = baseFacts({
			exitCode: null,
			signal: 'SIGTERM',
			resultMessageSeen: true,
			capturedAnswerText: undefined,
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'completed' });
	});

	it('does not flag a signal-terminated exit as crashed when an answer was captured (falls through to completed-with-warning)', () => {
		const facts = baseFacts({
			exitCode: null,
			signal: 'SIGTERM',
			resultMessageSeen: false,
			capturedAnswerText: 'partial answer before the signal',
		});

		const result = resolveTurnOutcome(facts, neverErrorsProvider(), CLAUDE_CTX);

		expect(result).toEqual({ outcome: 'completed-with-warning' });
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
