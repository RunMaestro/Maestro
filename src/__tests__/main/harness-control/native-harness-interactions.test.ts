// Source: src/__tests__/main/harness-control/HarnessControlRegistry.test.ts
// Source: src/__tests__/main/harness-control/integration.test.ts
// Source: src/__tests__/shared/harness-control/validators.test.ts
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { HarnessControlRegistry } from '../../../main/harness-control/HarnessControlRegistry';
import type { HarnessControlCapabilities } from '../../../shared/harness-control/types';
import type { HarnessControlHandle } from '../../../shared/harness-control/types';
import { beforeEach } from 'vitest';
import { HARNESS_INTERACTION_REQUEST_CHANNEL } from '../../../main/harness-control/integration';
import { harnessInteractionBroker } from '../../../main/harness-control/integration';
import { initHarnessControl } from '../../../main/harness-control/integration';
import { pendingHarnessInteractions } from '../../../main/harness-control/integration';
import { resolveHarnessInteractionResponse } from '../../../main/harness-control/integration';
import { broadcastBridgeEventToSessionSubscribers } from '../../../main/web-server/handlers/bridgeHandlers';
import { isBridgeSessionOwner } from '../../../main/web-server/handlers/bridgeHandlers';
import { parseHarnessControlCapabilities } from '../../../shared/harness-control/validators';
import { parseHarnessInteractionRequest } from '../../../shared/harness-control/validators';
import { parseHarnessInteractionResponse } from '../../../shared/harness-control/validators';

vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEventToSessionSubscribers: vi.fn(() => false),
	isBridgeSessionOwner: vi.fn(() => false),
}));
describe('HarnessControlRegistry', () => {
	const capabilities: HarnessControlCapabilities = {
		protocol: 'acp',
		protocolVersion: '1',
		steering: 'in-turn',
		permissionRequests: true,
		questions: false,
		elicitations: false,
		modelSwitch: false,
		modeSwitch: false,
		imagePrompts: false,
		resume: false,
	};

	function handleFixture(): HarnessControlHandle {
		return {
			getCapabilities: () => capabilities,
			steer: vi.fn(async ({ id, text }) => ({
				type: 'steering' as const,
				id,
				verdict: 'delivered' as const,
				detail: text,
			})),
			interrupt: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
	}

	describe('HarnessControlRegistry', () => {
		it('refuses steering when no running handle exists', async () => {
			const registry = new HarnessControlRegistry();
			await expect(registry.steer('missing', 'hello')).resolves.toMatchObject({
				verdict: 'refused',
				refusal: 'not-running',
			});
		});

		it('delegates control and exposes negotiated capabilities', async () => {
			const registry = new HarnessControlRegistry();
			const handle = handleFixture();
			registry.register('session-a', 1, handle);
			expect(registry.getCapabilities('session-a')).toEqual(capabilities);
			await expect(registry.steer('session-a', 'change course')).resolves.toMatchObject({
				verdict: 'delivered',
				detail: 'change course',
			});
			await expect(registry.interrupt('session-a')).resolves.toBe(true);
			expect(handle.interrupt).toHaveBeenCalledOnce();
		});

		it('closes a replaced handle and ignores stale cleanup', async () => {
			const registry = new HarnessControlRegistry();
			const oldHandle = handleFixture();
			const newHandle = handleFixture();
			registry.register('session-a', 1, oldHandle);
			registry.register('session-a', 2, newHandle);
			expect(oldHandle.close).toHaveBeenCalledOnce();
			expect(registry.unregister('session-a', oldHandle)).toBe(false);
			expect(registry.getCapabilities('session-a')).toEqual(capabilities);
			expect(registry.unregister('session-a', newHandle)).toBe(true);
			expect(registry.getCapabilities('session-a')).toBeNull();
		});
	});
});
describe('integration', () => {
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
		beforeEach(() => {
			harnessInteractionBroker.closeAll();
			vi.mocked(broadcastBridgeEventToSessionSubscribers).mockReturnValue(false);
			vi.mocked(isBridgeSessionOwner).mockReturnValue(false);
		});

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
			expect(
				pendingHarnessInteractions({ webContentsId: 1 }).map((request) => request.requestId)
			).toEqual([opened.request.requestId]);
			expect(pendingHarnessInteractions({ webContentsId: 2 })).toEqual([]);
			expect(first.webContents.send).toHaveBeenCalledWith(
				HARNESS_INTERACTION_REQUEST_CHANNEL,
				opened.request
			);
			expect(second.webContents.send).not.toHaveBeenCalled();
			expect(
				resolveHarnessInteractionResponse(
					{ requestId: opened.request.requestId, outcome: 'selected', optionId: 'allow' },
					{ webContentsId: 2 }
				)
			).toBe('not-found');
			expect(
				resolveHarnessInteractionResponse(
					{ requestId: opened.request.requestId, outcome: 'selected', optionId: 'allow' },
					{ webContentsId: 1 }
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

		it.each(['agent-a-batch-1700000000000', 'agent-a-synopsis-1700000000001'])(
			'routes background process %s to its owning window and browser',
			async (sessionId) => {
				const first = windowFixture(1);
				const second = windowFixture(2);
				initHarnessControl(
					{
						getWindowForSession: (id) => (id === 'agent-a' ? first : second) as never,
					},
					null
				);
				vi.mocked(isBridgeSessionOwner).mockImplementation(
					(clientId, id) => clientId === 'browser-a' && id === 'agent-a'
				);
				vi.mocked(broadcastBridgeEventToSessionSubscribers).mockReturnValue(true);

				const opened = harnessInteractionBroker.open({
					sessionId,
					spawnGeneration: 1,
					kind: 'permission',
					provider: 'fixture',
					title: 'Background request',
					options: [{ optionId: 'allow', label: 'Allow', kind: 'allow-once' }],
				});

				expect(first.webContents.send).toHaveBeenCalledWith(
					HARNESS_INTERACTION_REQUEST_CHANNEL,
					opened.request
				);
				expect(second.webContents.send).not.toHaveBeenCalled();
				expect(broadcastBridgeEventToSessionSubscribers).toHaveBeenCalledWith(
					HARNESS_INTERACTION_REQUEST_CHANNEL,
					[opened.request],
					'agent-a'
				);
				expect(pendingHarnessInteractions({ webContentsId: 1 })).toHaveLength(1);
				expect(pendingHarnessInteractions({ bridgeClientId: 'browser-a' })).toHaveLength(1);
			}
		);

		it('delivers to and authorizes only the subscribed browser owner', async () => {
			initHarnessControl({ getWindowForSession: () => null }, null);
			vi.mocked(isBridgeSessionOwner).mockImplementation(
				(clientId, sessionId) => clientId === 'browser-a' && sessionId === 'agent-a'
			);
			vi.mocked(broadcastBridgeEventToSessionSubscribers).mockReturnValue(true);
			const opened = harnessInteractionBroker.open({
				sessionId: 'agent-a-ai-tab-1',
				spawnGeneration: 1,
				kind: 'permission',
				provider: 'fixture',
				title: 'Run command',
				options: [{ optionId: 'allow', label: 'Allow', kind: 'allow-once' }],
			});
			expect(broadcastBridgeEventToSessionSubscribers).toHaveBeenCalledWith(
				HARNESS_INTERACTION_REQUEST_CHANNEL,
				[opened.request],
				'agent-a'
			);
			expect(pendingHarnessInteractions({ bridgeClientId: 'browser-a' })).toHaveLength(1);
			expect(pendingHarnessInteractions({ bridgeClientId: 'browser-b' })).toEqual([]);
			expect(pendingHarnessInteractions({})).toEqual([]);
			expect(
				resolveHarnessInteractionResponse(
					{ requestId: opened.request.requestId, outcome: 'selected', optionId: 'allow' },
					{ bridgeClientId: 'browser-b' }
				)
			).toBe('not-found');
			expect(
				resolveHarnessInteractionResponse(
					{ requestId: opened.request.requestId, outcome: 'selected', optionId: 'allow' },
					{ bridgeClientId: 'browser-a' }
				)
			).toBe('resolved');
			await expect(opened.completion).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
		});
	});
});
describe('validators', () => {
	const capabilities = {
		protocol: 'acp',
		protocolVersion: '1',
		steering: 'none',
		permissionRequests: true,
		questions: false,
		elicitations: false,
		modelSwitch: true,
		modeSwitch: true,
		imagePrompts: false,
		resume: true,
	};

	const permissionRequest = {
		requestId: 'request-a',
		sessionId: 'session-a',
		spawnGeneration: 1,
		kind: 'permission',
		provider: 'fixture',
		title: 'Run tests?',
		options: [{ optionId: 'allow', label: 'Allow once', kind: 'allow-once' }],
		createdAt: 1,
	};

	describe('harness-control validators', () => {
		it('accepts negotiated capabilities and rejects unsupported protocol values', () => {
			expect(parseHarnessControlCapabilities(capabilities)).toEqual(capabilities);
			expect(parseHarnessControlCapabilities({ ...capabilities, protocol: 'future' })).toBeNull();
			expect(parseHarnessControlCapabilities({ ...capabilities, resume: undefined })).toBeNull();
		});

		it('rejects duplicate option IDs and permission requests without options', () => {
			expect(
				parseHarnessInteractionRequest({
					...permissionRequest,
					options: [...permissionRequest.options, ...permissionRequest.options],
				})
			).toBeNull();
			expect(parseHarnessInteractionRequest({ ...permissionRequest, options: [] })).toBeNull();
		});

		it('preserves question descriptions, required flags, and defaults', () => {
			const question = {
				id: 'enabled',
				question: 'Enable it?',
				description: 'Defaults to the provider setting',
				required: false,
				default: 'true',
				allowEmpty: true,
				options: [],
			};
			expect(
				parseHarnessInteractionRequest({
					...permissionRequest,
					kind: 'elicitation',
					options: [],
					questions: [question],
				})?.questions
			).toEqual([question]);
			expect(
				parseHarnessInteractionRequest({
					...permissionRequest,
					kind: 'elicitation',
					options: [],
					questions: [{ ...question, default: 1 }],
				})
			).toBeNull();
		});

		it('validates selected, answer, and cancellation responses', () => {
			expect(
				parseHarnessInteractionResponse({
					requestId: 'request-a',
					outcome: 'selected',
					optionId: 'allow',
				})
			).toEqual({ requestId: 'request-a', outcome: 'selected', optionId: 'allow' });
			expect(
				parseHarnessInteractionResponse({
					requestId: 'request-a',
					outcome: 'answers',
					answers: { choice: ['native', 'current'] },
				})
			).toEqual({
				requestId: 'request-a',
				outcome: 'answers',
				answers: { choice: ['native', 'current'] },
			});
			expect(
				parseHarnessInteractionResponse({
					requestId: 'request-a',
					outcome: 'cancelled',
					reason: 'cancelled',
				})
			).toEqual({ requestId: 'request-a', outcome: 'cancelled', reason: 'cancelled' });
		});

		it('rejects malformed and approval-shaped answer payloads', () => {
			expect(parseHarnessInteractionResponse(null)).toBeNull();
			expect(
				parseHarnessInteractionResponse({
					requestId: 'request-a',
					outcome: 'selected',
					optionId: '',
				})
			).toBeNull();
			expect(
				parseHarnessInteractionResponse({
					requestId: 'request-a',
					outcome: 'answers',
					answers: { choice: ['native', 1] },
				})
			).toBeNull();
			expect(
				parseHarnessInteractionResponse({
					requestId: 'request-a',
					outcome: 'cancelled',
					reason: 'approved',
				})
			).toBeNull();
		});
	});
});
