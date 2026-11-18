/**
 * The mirrored agent's Edit Agent: the view of the host record the editor reads, and the record
 * its save arguments describe, which `saveHostedAgentSettings()` compares with the host's.
 */
import { describe, expect, it } from 'vitest';
import {
	editedHostRecord,
	hostedAgentEditSession,
} from '../../../../renderer/components/HostedAgentSettings/HostedAgentSettingsModal';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';

const host: AgentRecord = {
	id: 'h1',
	name: 'Docs',
	toolType: 'claude-code',
	cwd: '/home/me/docs',
	customModel: 'opus',
	nudgeMessage: 'keep going',
};

describe('hostedAgentEditSession', () => {
	it('presents the host agent as running over SSH on its peer, with pending edits in it', () => {
		const session = hostedAgentEditSession(
			host,
			{ peerId: 'box', remoteId: 'r-box' },
			{ nudgeMessage: 'pending' }
		);
		expect(session).toMatchObject({
			id: 'box:h1',
			name: 'Docs',
			nudgeMessage: 'pending',
			projectRoot: '/home/me/docs',
			aiTabs: [],
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'r-box',
				workingDirOverride: '/home/me/docs',
			},
		});
	});
});

describe('editedHostRecord', () => {
	it('reads the editor save arguments as the record they describe', () => {
		const args = new Array(28).fill(undefined) as Parameters<typeof editedHostRecord>[1];
		args[0] = 'box:h1';
		args[1] = 'Docs v2';
		args[3] = 'new nudge';
		args[9] = 'high';
		args[11] = { enabled: true, remoteId: 'r-box', workingDirOverride: '/home/me/docs2' };
		const edited = editedHostRecord(host, args);
		expect(edited).toMatchObject({
			name: 'Docs v2',
			nudgeMessage: 'new nudge',
			customEffort: 'high',
			cwd: '/home/me/docs2',
		});
		// Cleared in the editor: the field goes.
		expect(edited).not.toHaveProperty('customModel');
		expect(edited.toolType).toBe('claude-code');
	});
});
