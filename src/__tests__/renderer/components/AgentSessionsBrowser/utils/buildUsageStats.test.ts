import { describe, it, expect } from 'vitest';
import { buildUsageStats } from '../../../../../renderer/components/AgentSessionsBrowser/utils/buildUsageStats';
import { FALLBACK_CONTEXT_WINDOW } from '../../../../../shared/agentConstants';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		sessionId: 'abc123',
		projectPath: '/project',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: 'hello',
		messageCount: 5,
		sizeBytes: 1024,
		inputTokens: 100,
		outputTokens: 200,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 60,
		...overrides,
	};
}

describe('buildUsageStats', () => {
	it('returns undefined when costUsd is undefined', () => {
		expect(buildUsageStats(makeSession({ costUsd: undefined }))).toBeUndefined();
	});

	it('returns undefined when costUsd is 0', () => {
		expect(buildUsageStats(makeSession({ costUsd: 0 }))).toBeUndefined();
	});

	it('uses FALLBACK_CONTEXT_WINDOW as contextWindow', () => {
		const result = buildUsageStats(makeSession({ costUsd: 1.5 }));
		expect(result?.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
	});

	it('zeros all four token fields', () => {
		const result = buildUsageStats(
			makeSession({ costUsd: 1.5, inputTokens: 999, outputTokens: 888 })
		);
		expect(result?.inputTokens).toBe(0);
		expect(result?.outputTokens).toBe(0);
		expect(result?.cacheReadInputTokens).toBe(0);
		expect(result?.cacheCreationInputTokens).toBe(0);
	});

	it('preserves positive costUsd', () => {
		const result = buildUsageStats(makeSession({ costUsd: 3.14 }));
		expect(result?.totalCostUsd).toBe(3.14);
	});

	it('preserves large costUsd', () => {
		const result = buildUsageStats(makeSession({ costUsd: 9999.99 }));
		expect(result?.totalCostUsd).toBe(9999.99);
	});

	it('preserves fractional costUsd', () => {
		const result = buildUsageStats(makeSession({ costUsd: 0.001 }));
		expect(result?.totalCostUsd).toBe(0.001);
	});

	it('is pure - same input produces same output without mutating the session', () => {
		const session = makeSession({ costUsd: 2.0 });
		const before = JSON.stringify(session);
		const r1 = buildUsageStats(session);
		const r2 = buildUsageStats(session);
		expect(r1).toEqual(r2);
		expect(JSON.stringify(session)).toBe(before);
	});
});
