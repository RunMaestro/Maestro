/**
 * Mode parity for the stateless one-shots (rows A1.11 and A1.12): tab auto-naming (and Rename
 * Tab "Auto", which is the same request forced) and the AI command suggestion.
 *
 * Each writes nothing into the agent's transcript, so it runs over the record's SSH remote for an
 * SSH and a hosted agent alike: the request is the same in every mode except that transport, the
 * user sees the same result, and a hosted tab's name also reaches its host (`rename-tab`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestTabAutoName } from '../../../renderer/services/tabAutoNaming';
import { requestAiCommand } from '../../../renderer/services/aiCommand';
import { aiCommandKey, useAiCommandStore } from '../../../renderer/stores/aiCommandStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';
import { AGENT_MODES, createModeSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

vi.mock('../../../renderer/services/shellCommand', () => ({
	dispatchShellCommand: vi.fn().mockResolvedValue(undefined),
	resolveCommandCwd: vi.fn(() => '/repo'),
}));

const maestro = window.maestro as unknown as Record<string, unknown>;
const generateTabName = vi.fn<(config: unknown) => Promise<string | null>>();
const suggest = vi.fn();
const act$ = vi.fn();

/** Let the fire-and-forget naming chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function seed(mode: (typeof AGENT_MODES)[number]) {
	const session = createModeSession(mode, {
		id: 'agent-1',
		cwd: '/repo',
		activeTabId: 'tab-1',
		aiTabs: [createMockAITab({ id: 'tab-1', name: null })],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	// The host lists the same tab: a lift keeps tab ids.
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 'tab-1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
	return session;
}

/** The request with its transport removed: what must match across modes. */
function withoutTransport(config: unknown) {
	const { sessionSshRemoteConfig, sshRemoteName, ...rest } = config as Record<string, unknown>;
	return { rest, ssh: sessionSshRemoteConfig, sshRemoteName };
}

describe('stateless one-shots: same request and result in every mode', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({
			federationHostedAgents: true,
			automaticTabNamingEnabled: true,
		} as never);
		useAiCommandStore.setState({ entries: {} });
		generateTabName.mockReset().mockResolvedValue('Ingest Pipeline');
		suggest.mockReset().mockResolvedValue({ success: true, command: 'du -sh *' });
		act$.mockReset().mockResolvedValue({ ok: true, result: { kind: 'rename-tab' } });
		maestro.tabNaming = { generateTabName };
		maestro.aiCommand = { suggest };
		maestro.federation = { act: act$ };
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('A1.11: auto-naming sends one request, names the tab, and a hosted name reaches the host', async () => {
		const requests: ReturnType<typeof withoutTransport>[] = [];
		const names: (string | null | undefined)[] = [];
		for (const mode of AGENT_MODES) {
			const session = seed(mode);
			generateTabName.mockClear();
			act$.mockClear();

			// The Rename Tab modal's "Auto" button is this same call with `force`.
			requestTabAutoName({ session, tabId: 'tab-1', prompt: 'wire up the ingest pipeline' });
			await flush();

			expect(generateTabName).toHaveBeenCalledTimes(1);
			requests.push(withoutTransport(generateTabName.mock.calls[0][0]));
			names.push(useSessionStore.getState().sessions[0].aiTabs[0].name);

			if (mode === 'hosted') {
				expect(act$).toHaveBeenCalledWith('box', 'h1', {
					kind: 'rename-tab',
					tabId: 'tab-1',
					name: 'Ingest Pipeline',
				});
			} else {
				expect(act$).not.toHaveBeenCalled();
			}
		}
		expect(names).toEqual(['Ingest Pipeline', 'Ingest Pipeline', 'Ingest Pipeline']);
		expect(requests[1].rest).toEqual(requests[0].rest);
		expect(requests[2].rest).toEqual(requests[0].rest);
		expect(requests[0].rest.ownerAgentId).toBe('agent-1');
		// The transport: an SSH and a hosted agent both run the namer over the record's remote.
		expect(requests[0].ssh).toBeUndefined();
		expect(requests[1].ssh).toEqual({ enabled: true, remoteId: 'r1' });
		expect(requests[2].ssh).toEqual(requests[1].ssh);
	});

	it('A1.12: the AI command suggestion sends one request and shows the same proposal', async () => {
		const requests: ReturnType<typeof withoutTransport>[] = [];
		const proposals: (string | undefined)[] = [];
		for (const mode of AGENT_MODES) {
			const session = seed(mode);
			suggest.mockClear();
			useAiCommandStore.setState({ entries: {} });

			await requestAiCommand({ session, tabId: 'tab-1', request: 'how big is each folder' });

			expect(suggest).toHaveBeenCalledTimes(1);
			requests.push(withoutTransport(suggest.mock.calls[0][0]));
			const entry = useAiCommandStore.getState().entries[aiCommandKey('agent-1', 'tab-1')];
			proposals.push(entry?.command);
		}
		expect(proposals).toEqual(['du -sh *', 'du -sh *', 'du -sh *']);
		expect(requests[1].rest).toEqual(requests[0].rest);
		expect(requests[2].rest).toEqual(requests[0].rest);
		// Main checks the launch against the owning agent; the suggestion is a named helper.
		expect(requests[0].rest.ownerAgentId).toBe('agent-1');
		expect(requests[0].ssh).toBeUndefined();
		expect(requests[2].ssh).toEqual(requests[1].ssh);
		// Nothing about the suggestion is sent to the host: it never enters the transcript.
		expect(act$).not.toHaveBeenCalled();
	});
});
