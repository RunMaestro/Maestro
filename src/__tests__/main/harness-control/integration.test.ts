import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
	pendingHarnessInteractions,
	resolveHarnessInteractionResponse,
} from '../../../main/harness-control/integration';

function windowFixture(id: number) {
	return {
		isDestroyed: () => false,
		webContents: {
			id,
			isDestroyed: () => false,
			send: vi.fn(),
		},
	};
}

describe('native interaction owner authorization', () => {
	beforeEach(() => harnessInteractionBroker.closeAll());

	it('filters list/respond by canonical owning window and blocks another owner', async () => {
		const first = windowFixture(1);
		const second = windowFixture(2);
		initHarnessControl(
			{
				getWindowForSession: (sessionId) => (sessionId === 'agent-a' ? first : second) as never,
			},
			null
		);
		const opened = harnessInteractionBroker.open({
			sessionId: 'agent-a-ai-tab-1',
			spawnGeneration: 1,
			kind: 'permission',
			provider: 'fixture',
			title: 'Run command',
			options: [{ optionId: 'allow', label: 'Allow', kind: 'allow-once' }],
		});
		expect(pendingHarnessInteractions(1).map((request) => request.requestId)).toEqual([
			opened.request.requestId,
		]);
		expect(pendingHarnessInteractions(2)).toEqual([]);
		expect(first.webContents.send).toHaveBeenCalledWith(
			HARNESS_INTERACTION_REQUEST_CHANNEL,
			opened.request
		);
		expect(second.webContents.send).not.toHaveBeenCalled();
		expect(
			resolveHarnessInteractionResponse(
				{ requestId: opened.request.requestId, outcome: 'selected', optionId: 'allow' },
				2
			)
		).toBe('not-found');
		expect(
			resolveHarnessInteractionResponse(
				{ requestId: opened.request.requestId, outcome: 'selected', optionId: 'allow' },
				1
			)
		).toBe('resolved');
		await expect(opened.completion).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
	});

	it('fails closed instead of using the primary window for an unknown owner', async () => {
		initHarnessControl({ getWindowForSession: () => null }, null);
		const opened = harnessInteractionBroker.open({
			sessionId: 'unknown-agent-ai-tab-1',
			spawnGeneration: 1,
			kind: 'permission',
			provider: 'fixture',
			title: 'Unowned request',
			options: [{ optionId: 'deny', label: 'Deny', kind: 'reject-once' }],
		});
		await expect(opened.completion).resolves.toEqual({
			outcome: 'cancelled',
			reason: 'owner-unavailable',
		});
	});
});
