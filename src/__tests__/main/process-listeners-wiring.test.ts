import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessManager } from '../../main/process-manager';
import type { ProcessListenerDependencies } from '../../main/process-listeners/types';
import type { AgentCapabilitiesSnapshot } from '../../shared/agentCapabilities';

// Stub the desktop boundaries before importing the real composition function.
// No singleton stores, engines, native processes or listener timers may start.
vi.mock('../../main/process-listeners', () => ({ setupProcessListeners: vi.fn() }));
vi.mock('../../main/process-listeners/wakatime-listener', () => ({
	setupWakaTimeListener: vi.fn(),
}));
vi.mock('../../main/process-listeners/cot-export-listener', () => ({
	setupCotExportListener: vi.fn(),
}));
vi.mock('../../main/cot-export/config-store', () => ({ getCotConfigStore: vi.fn() }));
vi.mock('../../main/cot-export/resolve-agent', () => ({
	peekCotAgentId: vi.fn(),
	resolveCotTarget: vi.fn(),
}));
vi.mock('../../main/cot-export/runtime', () => ({ getCotWriter: vi.fn() }));
vi.mock('../../main/cross-agent/cross-agent-router', () => ({
	getCrossAgentConsultParties: vi.fn(),
}));
vi.mock('../../main/stores/getters', () => ({ getSessionsStore: vi.fn() }));
vi.mock('../../main/power-manager', () => ({
	powerManager: { addBlockReason: vi.fn(), removeBlockReason: vi.fn() },
}));
vi.mock('../../main/group-chat/emitters', () => ({ groupChatEmitters: {} }));
vi.mock('../../main/group-chat/desktop-engine', () => ({
	desktopGroupChatEngine: {},
	desktopLauncherFor: vi.fn(),
}));
vi.mock('../../main/group-chat/group-chat-storage', () => ({
	updateParticipant: vi.fn(),
	loadGroupChat: vi.fn(),
	updateGroupChat: vi.fn(),
	getParticipant: vi.fn(),
}));
vi.mock('../../main/group-chat/output-buffer', () => ({
	appendToGroupChatBuffer: vi.fn(),
	getGroupChatBufferedOutput: vi.fn(),
	clearGroupChatBuffer: vi.fn(),
}));
vi.mock('../../main/group-chat/session-parser', () => ({ parseParticipantSessionId: vi.fn() }));
vi.mock('../../main/group-chat/output-parser', () => ({ extractTextFromStreamJson: vi.fn() }));
vi.mock('../../main/constants', () => ({
	REGEX_MODERATOR_SESSION: /^group-chat-(.+)-moderator-\d+$/,
	REGEX_AI_SUFFIX: /-ai$/,
	REGEX_AI_TAB_ID: /^(.+)-ai-(.+)$/,
	REGEX_BATCH_SESSION: /^(.+)-batch-\d+$/,
	REGEX_SYNOPSIS_SESSION: /^(.+)-synopsis-\d+$/,
	debugLog: vi.fn(),
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../main/agents/capability-snapshot', () => ({
	capabilitySnapshots: { get: vi.fn() },
}));
vi.mock('../../main/agents/definitions', () => ({ getAgentDefinition: vi.fn() }));

import {
	wireProcessListeners,
	type ProcessListenersWiringDependencies,
} from '../../main/process-listeners-wiring';
import { setupProcessListeners } from '../../main/process-listeners';
import { capabilitySnapshots } from '../../main/agents/capability-snapshot';
import { getAgentDefinition } from '../../main/agents/definitions';
import { FALLBACK_CONTEXT_WINDOW } from '../../shared/agentConstants';

describe('wireProcessListeners context-window resolution', () => {
	let getAgentContextWindow: NonNullable<ProcessListenerDependencies['getAgentContextWindow']>;

	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(getAgentDefinition).mockReturnValue({
			id: 'fixture-provider',
			name: 'Fixture provider',
			binaryName: 'fixture',
			command: 'fixture',
			args: [],
			configOptions: [
				{ key: 'other', type: 'number', label: 'Other', description: '', default: 96_000 },
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context window',
					description: '',
					default: 64_000,
				},
			],
		});
		// Match the existing listener suites' EventEmitter process-manager fixture.
		const processManager = new EventEmitter() as unknown as ProcessManager;
		wireProcessListeners({
			getProcessManager: () => processManager,
			getWebServer: () => null,
			getAgentDetector: () => null,
			getCueEngine: () => null,
			getPluginEventBus: () => null,
			safeSend: vi.fn(),
			settingsStore: {
				get: vi.fn(),
			} as unknown as ProcessListenersWiringDependencies['settingsStore'],
			wakatimeManager: {} as ProcessListenersWiringDependencies['wakatimeManager'],
		});
		expect(setupProcessListeners).toHaveBeenCalledExactlyOnceWith(
			processManager,
			expect.objectContaining({ getAgentContextWindow: expect.any(Function) })
		);
		getAgentContextWindow =
			vi.mocked(setupProcessListeners).mock.calls[0][1].getAgentContextWindow!;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{ host: 'local', remoteId: undefined, contextWindow: 500_000 },
		{ host: 'SSH', remoteId: 'fixture-remote', contextWindow: 1_000_000 },
	])('keeps Grok unknown without reading a $host snapshot or definition', (metadata) => {
		const snapshot: AgentCapabilitiesSnapshot = {
			status: 'ready',
			lastProbedAt: 1,
			contextWindow: metadata.contextWindow,
			remoteId: metadata.remoteId,
			models: ['grok-4.5'],
		};
		vi.mocked(capabilitySnapshots.get).mockReturnValue(snapshot);

		expect(getAgentContextWindow('grok')).toBe(0);
		expect(capabilitySnapshots.get).not.toHaveBeenCalled();
		expect(getAgentDefinition).not.toHaveBeenCalled();
	});

	it('resolves Grok to unknown even when metadata readers would throw', () => {
		vi.mocked(capabilitySnapshots.get).mockImplementation(() => {
			throw new Error('Provider-only snapshot must not be read');
		});
		vi.mocked(getAgentDefinition).mockImplementation(() => {
			throw new Error('Provider definition must not be read');
		});

		expect(getAgentContextWindow('grok')).toBe(0);
		expect(capabilitySnapshots.get).not.toHaveBeenCalled();
		expect(getAgentDefinition).not.toHaveBeenCalled();
	});

	it.each(['claude-code', 'opencode', 'fixture-provider'])(
		'prefers a positive snapshot over table and definition defaults for %s',
		(agentId) => {
			vi.mocked(capabilitySnapshots.get).mockReturnValue({
				status: 'ready',
				lastProbedAt: 1,
				contextWindow: 333_000,
			});

			expect(getAgentContextWindow(agentId)).toBe(333_000);
			expect(capabilitySnapshots.get).toHaveBeenCalledExactlyOnceWith(agentId);
			expect(getAgentDefinition).not.toHaveBeenCalled();
		}
	);

	it.each([
		['claude-code', 200_000],
		['opencode', 128_000],
		['antigravity', 1_048_576],
		['terminal', 0],
	] as const)('prefers the static table over the definition for %s', (agentId, expected) => {
		expect(getAgentContextWindow(agentId)).toBe(expected);
		expect(capabilitySnapshots.get).toHaveBeenCalledExactlyOnceWith(agentId);
	});

	it.each([undefined, 0, -1, NaN])(
		'ignores an unusable snapshot window (%s) and retains table/definition precedence',
		(contextWindow) => {
			vi.mocked(capabilitySnapshots.get).mockReturnValue({
				status: 'ready',
				lastProbedAt: 1,
				contextWindow,
			});

			expect(getAgentContextWindow('opencode')).toBe(128_000);
			expect(getAgentContextWindow('terminal')).toBe(0);
			expect(getAgentContextWindow('fixture-provider')).toBe(64_000);
		}
	);

	it('uses the definition default when neither snapshot nor table supplies a window', () => {
		expect(getAgentContextWindow('fixture-provider')).toBe(64_000);
		expect(getAgentDefinition).toHaveBeenCalledExactlyOnceWith('fixture-provider');
	});

	it('uses the global fallback when no definition exists', () => {
		vi.mocked(getAgentDefinition).mockReturnValue(undefined);

		expect(getAgentContextWindow('fixture-provider')).toBe(FALLBACK_CONTEXT_WINDOW);
	});

	it.each([
		{ label: 'absent options', configOptions: undefined },
		{ label: 'empty options', configOptions: [] },
		{
			label: 'a nonnumeric default',
			configOptions: [
				{ key: 'contextWindow', type: 'text', label: 'Context', description: '', default: '64000' },
			],
		},
	] satisfies Array<{
		label: string;
		configOptions: NonNullable<ReturnType<typeof getAgentDefinition>>['configOptions'];
	}>)('uses the global fallback when the definition has $label', ({ configOptions }) => {
		vi.mocked(getAgentDefinition).mockReturnValue({
			...getAgentDefinition('fixture-provider')!,
			configOptions,
		});

		expect(getAgentContextWindow('fixture-provider')).toBe(FALLBACK_CONTEXT_WINDOW);
	});
});
