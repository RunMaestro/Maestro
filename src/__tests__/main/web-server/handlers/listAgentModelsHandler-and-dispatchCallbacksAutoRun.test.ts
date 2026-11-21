// Source: src/__tests__/main/web-server/handlers/listAgentModelsHandler.test.ts
// Source: src/__tests__/main/web-server/handlers/dispatchCallbacksAutoRun.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { handleListAgentModels } from '../../../../main/web-server/handlers/messageHandlers/models';
import { discoverAgentModels } from '../../../../main/agents/model-discovery';
import { getSshRemoteById } from '../../../../main/stores/getters';
import { afterEach } from 'vitest';
import type { AutoRunDelegationEvent } from '../../../../shared/autoRunDelegation';
import { armDispatchCallback } from '../../../../main/web-server/handlers/messageHandlers/dispatchCallbacks';
import { readAutoRunCallbackRequest } from '../../../../main/web-server/handlers/messageHandlers/dispatchCallbacks';
import { wantsDispatchCallback } from '../../../../main/web-server/handlers/messageHandlers/dispatchCallbacks';
import { disposeDispatchCallbacks } from '../../../../main/dispatch-callbacks';
import { getDispatchCallbackRegistry } from '../../../../main/dispatch-callbacks';
import { initDispatchCallbacks } from '../../../../main/dispatch-callbacks';
import { getAutoRunStateTracker } from '../../../../main/autorun/autorun-state-tracker';
import { resetAutoRunStateTracker } from '../../../../main/autorun/autorun-state-tracker';
import type { MessageHandlerContext } from '../../../../main/web-server/handlers/messageHandlers/types';
import type { WebClientMessage } from '../../../../main/web-server/handlers/messageHandlers/types';
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/agents/model-discovery', () => ({
	discoverAgentModels: vi.fn(),
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSshRemoteById: vi.fn(),
}));
describeSourceSuite('listAgentModelsHandler', () => {
	const detector = { discoverModels: vi.fn() };

	function makeCtx() {
		return {
			send: vi.fn(),
			sendError: vi.fn(),
			reportHandlerError: vi.fn(),
			callbacks: { getDebugPackageDeps: () => ({ getAgentDetector: () => detector }) },
		};
	}

	const client = { id: 'c1', connectedAt: 0, cli: true } as never;

	describe('handleListAgentModels', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('runs the shared discovery and replies with the list', async () => {
			vi.mocked(discoverAgentModels).mockResolvedValue(['ollama/qwen3:8b']);
			const ctx = makeCtx();

			await handleListAgentModels(ctx as never, client, {
				type: 'list_agent_models',
				agentId: 'opencode',
				requestId: 'r1',
			});

			const [deps, options] = vi.mocked(discoverAgentModels).mock.calls[0];
			expect(options).toEqual({ agentId: 'opencode', forceRefresh: false, sshRemoteId: undefined });
			// The detector and SSH lookup are the app's own, not a second copy.
			expect(deps.getAgentDetector()).toBe(detector);
			expect(deps.getSshRemote).toBe(getSshRemoteById);
			expect(ctx.send).toHaveBeenCalledWith(client, {
				type: 'list_agent_models_result',
				success: true,
				agentId: 'opencode',
				sshRemoteId: null,
				models: ['ollama/qwen3:8b'],
				requestId: 'r1',
			});
		});

		it('forces a refresh and targets an SSH remote when asked', async () => {
			vi.mocked(discoverAgentModels).mockResolvedValue([]);
			const ctx = makeCtx();

			await handleListAgentModels(ctx as never, client, {
				type: 'list_agent_models',
				agentId: 'opencode',
				refresh: true,
				sshRemoteId: 'remote-1',
			});

			expect(vi.mocked(discoverAgentModels).mock.calls[0][1]).toEqual({
				agentId: 'opencode',
				forceRefresh: true,
				sshRemoteId: 'remote-1',
			});
			expect(ctx.send.mock.calls[0][1]).toMatchObject({ success: true, sshRemoteId: 'remote-1' });
		});

		it('rejects an unknown provider without running discovery', async () => {
			const ctx = makeCtx();

			await handleListAgentModels(ctx as never, client, {
				type: 'list_agent_models',
				agentId: 'not-a-provider',
			});

			expect(discoverAgentModels).not.toHaveBeenCalled();
			expect(ctx.send.mock.calls[0][1]).toMatchObject({
				type: 'list_agent_models_result',
				success: false,
				error: 'Unknown provider "not-a-provider".',
			});
		});

		it('reports a discovery failure instead of throwing', async () => {
			vi.mocked(discoverAgentModels).mockRejectedValue(new Error('SSH remote not found: gone'));
			const ctx = makeCtx();

			await handleListAgentModels(ctx as never, client, {
				type: 'list_agent_models',
				agentId: 'opencode',
				sshRemoteId: 'gone',
			});

			expect(ctx.send.mock.calls[0][1]).toMatchObject({
				success: false,
				error: 'SSH remote not found: gone',
			});
		});
	});
});
describeSourceSuite('dispatchCallbacksAutoRun', () => {
	const ctx = {
		callbacks: {
			getSessions: () => [{ id: 'worker', name: 'Worker' }],
			getSessionDetail: () => ({}),
		},
	} as unknown as MessageHandlerContext;

	const target = { agentId: 'worker', tabId: 'tab-1', prompt: 'build it', isNewTab: true };

	function message(extra: Record<string, unknown> = {}): WebClientMessage {
		return {
			type: 'new_ai_tab_with_prompt',
			fromSessionId: 'manager',
			autoRunId: 'autorun-1',
			...extra,
		};
	}

	describe('readAutoRunCallbackRequest', () => {
		it('reads the run and the caller', () => {
			expect(readAutoRunCallbackRequest(message())).toEqual({
				autoRunId: 'autorun-1',
				callerAgentId: 'manager',
			});
		});

		it('yields to an explicit --notify-on-complete', () => {
			expect(readAutoRunCallbackRequest(message({ notifyOnComplete: 'someone' }))).toBeUndefined();
		});

		it('needs a caller to report to', () => {
			expect(readAutoRunCallbackRequest(message({ fromSessionId: undefined }))).toBeUndefined();
			expect(wantsDispatchCallback({ type: 'send_command' })).toBe(false);
			expect(wantsDispatchCallback(message())).toBe(true);
		});
	});

	describe('armDispatchCallback for an Auto Run', () => {
		let notifyAutoRun: ReturnType<typeof vi.fn<(event: AutoRunDelegationEvent) => void>>;

		beforeEach(() => {
			resetAutoRunStateTracker();
			notifyAutoRun = vi.fn<(event: AutoRunDelegationEvent) => void>();
			initDispatchCallbacks({
				enqueue: vi.fn().mockResolvedValue({ success: true }),
				openTab: vi.fn().mockResolvedValue({ success: true }),
				notifyAutoRun,
			});
		});

		afterEach(() => {
			disposeDispatchCallbacks();
			resetAutoRunStateTracker();
		});

		it('arms tracking addressed to the run while the caller has one running', () => {
			getAutoRunStateTracker().update('manager', {
				isRunning: true,
				completedTasks: 0,
				totalTasks: 1,
			});
			const armed = armDispatchCallback(ctx, message({ callbackTimeout: 120 }), target);
			expect(armed.error).toBeUndefined();
			const entry = getDispatchCallbackRegistry()!.get(armed.callbackId!);
			expect(entry).toMatchObject({
				autoRunId: 'autorun-1',
				callerAgentId: 'manager',
				targetName: 'Worker',
				timeoutMs: 120_000,
			});
			expect(notifyAutoRun).toHaveBeenCalledWith(expect.objectContaining({ kind: 'started' }));
		});

		it('leaves the dispatch untracked, not refused, when the run is over', () => {
			// A daemon an earlier task started still carries the run id in its env.
			const armed = armDispatchCallback(ctx, message(), target);
			expect(armed).toEqual({});
			expect(getDispatchCallbackRegistry()!.list()).toHaveLength(0);
		});

		it('leaves the dispatch untracked when the tab already carries a callback', () => {
			getAutoRunStateTracker().update('manager', {
				isRunning: true,
				completedTasks: 0,
				totalTasks: 1,
			});
			getDispatchCallbackRegistry()!.register({
				targetAgentId: 'worker',
				targetTabId: 'tab-1',
				callerAgentId: 'someone',
				timeoutMs: 60_000,
				prompt: 'earlier',
			});
			const armed = armDispatchCallback(ctx, message(), target);
			expect(armed).toEqual({});
		});

		it('allows a run to delegate to a new tab of its own agent', () => {
			getAutoRunStateTracker().update('manager', {
				isRunning: true,
				completedTasks: 0,
				totalTasks: 1,
			});
			const armed = armDispatchCallback(ctx, message(), { ...target, agentId: 'manager' });
			expect(armed.callbackId).toBeDefined();
		});
	});
});
