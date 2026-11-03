import { describe, expect, it, vi } from 'vitest';
import { InteractionBroker } from '../../../main/harness-control/InteractionBroker';
import type {
	HarnessInteractionOpenRequest,
	HarnessInteractionSettledEvent,
} from '../../../shared/harness-control/types';
import fixture from '../../fixtures/harness-control/interactions.json';

const permission = fixture.permission as HarnessInteractionOpenRequest;
const question = fixture.question as HarnessInteractionOpenRequest;

function brokerHarness(delivered: boolean | void = true) {
	const requests: string[] = [];
	const settled: HarnessInteractionSettledEvent[] = [];
	const broker = new InteractionBroker({
		onRequest: (request) => {
			requests.push(request.requestId);
			return delivered;
		},
		onSettled: (event) => settled.push(event),
	});
	return { broker, requests, settled };
}

describe('InteractionBroker', () => {
	it('settles a native selection once and omits response values from events', async () => {
		const { broker, requests, settled } = brokerHarness();
		const opened = broker.open(permission);
		expect(requests).toEqual([opened.request.requestId]);
		expect(
			broker.resolve({
				requestId: opened.request.requestId,
				outcome: 'selected',
				optionId: 'allow',
			})
		).toBe('resolved');
		await expect(opened.completion).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
		expect(
			broker.resolve({
				requestId: opened.request.requestId,
				outcome: 'selected',
				optionId: 'allow',
			})
		).toBe('not-found');
		expect(settled).toEqual([
			{
				requestId: opened.request.requestId,
				sessionId: 'session-a',
				spawnGeneration: 1,
				outcome: 'selected',
			},
		]);
		expect(settled[0]).not.toHaveProperty('optionId');
	});

	it('rejects an unoffered option without settling the request', async () => {
		const { broker } = brokerHarness();
		const opened = broker.open(permission);
		expect(
			broker.resolve({
				requestId: opened.request.requestId,
				outcome: 'selected',
				optionId: 'always',
			})
		).toBe('invalid-response');
		expect(broker.pendingRequests()).toHaveLength(1);
		expect(
			broker.resolve({ requestId: opened.request.requestId, outcome: 'selected', optionId: 'deny' })
		).toBe('resolved');
		await expect(opened.completion).resolves.toEqual({ outcome: 'selected', optionId: 'deny' });
	});

	it('cancels only the matching session generation on replacement', async () => {
		const { broker } = brokerHarness();
		const oldRequest = broker.open(permission);
		const newRequest = broker.open({ ...permission, spawnGeneration: 2 });
		expect(broker.closeSession('session-a', 1, 'superseded')).toBe(1);
		await expect(oldRequest.completion).resolves.toEqual({
			outcome: 'cancelled',
			reason: 'superseded',
		});
		expect(broker.pendingRequests().map((request) => request.requestId)).toEqual([
			newRequest.request.requestId,
		]);
		expect(broker.closeSession('session-a', 2)).toBe(1);
		await expect(newRequest.completion).resolves.toEqual({
			outcome: 'cancelled',
			reason: 'process-exited',
		});
	});

	it('fails closed when no owner can display a request', async () => {
		const { broker } = brokerHarness(false);
		const opened = broker.open(permission);
		await expect(opened.completion).resolves.toEqual({
			outcome: 'cancelled',
			reason: 'owner-unavailable',
		});
		expect(broker.pendingRequests()).toHaveLength(0);
	});

	it('times out with a cancellation and a withdrawal event', async () => {
		vi.useFakeTimers();
		try {
			const { broker, settled } = brokerHarness();
			const opened = broker.open(permission, 100);
			vi.advanceTimersByTime(101);
			await expect(opened.completion).resolves.toEqual({ outcome: 'cancelled', reason: 'timeout' });
			expect(settled[0].reason).toBe('timeout');
			expect(broker.pendingRequests()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('accepts answers for questions but not for permission requests', async () => {
		const { broker } = brokerHarness();
		const questionRequest = broker.open(question);
		expect(
			broker.resolve({
				requestId: questionRequest.request.requestId,
				outcome: 'answers',
				answers: { implementation: 'native' },
			})
		).toBe('resolved');
		await expect(questionRequest.completion).resolves.toEqual({
			outcome: 'answers',
			answers: { implementation: 'native' },
		});

		const permissionRequest = broker.open(permission);
		expect(
			broker.resolve({
				requestId: permissionRequest.request.requestId,
				outcome: 'answers',
				answers: { implementation: 'native' },
			})
		).toBe('invalid-response');
		expect(broker.withdraw(permissionRequest.request.requestId)).toBe(true);
		await expect(permissionRequest.completion).resolves.toEqual({
			outcome: 'cancelled',
			reason: 'withdrawn',
		});
	});
});
