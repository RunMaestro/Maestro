import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({ captureMessage: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { captureMessage } from '../../../main/utils/sentry';
import {
	checkHostedAgentLaunch,
	installHostedLaunchGuard,
} from '../../../main/utils/hosted-launch-guard';
import {
	HOSTED_SSH_RUNS,
	HOSTED_STATELESS_HELPERS,
	cueAssistProcessId,
	statelessHelperOfProcess,
	type HostedLaunchFeature,
} from '../../../shared/maestro-lib/agents/hosted-launch';
import { AGENT_MODES, agentModeFields } from '../../helpers/mockSession';

/** Launches no list allows: a consult that did not go to the host, and an unnamed one-shot. */
const UNLISTED: HostedLaunchFeature[] = ['consult', 'groom-context'];

describe('checkHostedAgentLaunch', () => {
	let hostedEnabled = true;

	const install = (mode: (typeof AGENT_MODES)[number]) =>
		installHostedLaunchGuard({
			sessions: () => [{ id: 'agent-1', ...agentModeFields(mode) }],
			hostedEnabled: () => hostedEnabled,
		});

	beforeEach(() => {
		hostedEnabled = true;
		vi.mocked(captureMessage).mockClear();
	});
	afterEach(() => installHostedLaunchGuard(null));

	it.each(AGENT_MODES)('lets every stateless helper of a %s agent through unreported', (mode) => {
		install(mode);
		for (const helper of Object.keys(HOSTED_STATELESS_HELPERS) as HostedLaunchFeature[]) {
			expect(checkHostedAgentLaunch('agent-1', helper)).toBe(
				mode === 'hosted' ? 'allowed' : 'not-hosted'
			);
		}
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it.each(AGENT_MODES)(
		'lets a Cue run and a group chat turn of a %s agent through unreported: they run over SSH by decision',
		(mode) => {
			install(mode);
			for (const run of Object.keys(HOSTED_SSH_RUNS) as HostedLaunchFeature[]) {
				expect(checkHostedAgentLaunch('agent-1', run)).toBe(
					mode === 'hosted' ? 'allowed' : 'not-hosted'
				);
			}
			expect(captureMessage).not.toHaveBeenCalled();
		}
	);

	it.each(AGENT_MODES)(
		'reports an unlisted launch of a %s agent only when it is hosted, by feature name',
		(mode) => {
			install(mode);
			for (const feature of UNLISTED) {
				expect(checkHostedAgentLaunch('agent-1', feature)).toBe(
					mode === 'hosted' ? 'unlisted' : 'not-hosted'
				);
			}
			if (mode === 'hosted') {
				expect(captureMessage).toHaveBeenCalledTimes(UNLISTED.length);
				expect(captureMessage).toHaveBeenCalledWith(
					'Hosted agent launch on this machine: consult',
					'warning',
					{ feature: 'consult', agentId: 'agent-1' }
				);
			} else {
				expect(captureMessage).not.toHaveBeenCalled();
			}
		}
	);

	it('reads a lifted record as its SSH agent while hosted agents are off', () => {
		install('hosted');
		hostedEnabled = false;
		expect(checkHostedAgentLaunch('agent-1', 'cue-run')).toBe('not-hosted');
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it('never blocks a launch: a store that cannot be read is not hosted, and is not reported', () => {
		installHostedLaunchGuard({
			sessions: () => {
				throw new Error('store is locked');
			},
			hostedEnabled: () => true,
		});
		expect(checkHostedAgentLaunch('agent-1', 'consult')).toBe('not-hosted');
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it('checks nothing for a launch with no agent, an unknown agent, or no installed stores', () => {
		install('hosted');
		expect(checkHostedAgentLaunch(undefined, 'consult')).toBe('not-hosted');
		expect(checkHostedAgentLaunch('someone-else', 'consult')).toBe('not-hosted');
		installHostedLaunchGuard(null);
		expect(checkHostedAgentLaunch('agent-1', 'consult')).toBe('not-hosted');
		expect(captureMessage).not.toHaveBeenCalled();
	});
});

describe('statelessHelperOfProcess', () => {
	it('names the Cue AI chat helper by its id, and no real turn', () => {
		expect(statelessHelperOfProcess(cueAssistProcessId('agent-1', 5), 'agent-1')).toBe(
			'cue-assist'
		);
		for (const turn of ['agent-1-ai-tab', 'agent-1-batch-1', 'agent-1-synopsis-1', 'agent-1']) {
			expect(statelessHelperOfProcess(turn, 'agent-1')).toBeUndefined();
		}
		// Another agent's helper is not this agent's.
		expect(statelessHelperOfProcess(cueAssistProcessId('agent-2', 5), 'agent-1')).toBeUndefined();
	});
});
