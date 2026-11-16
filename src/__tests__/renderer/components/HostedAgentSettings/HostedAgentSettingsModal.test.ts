/**
 * The mirrored agent's Edit Agent: the view of the host record the editor reads, and the record
 * its save arguments describe, which `saveHostedAgentSettings()` compares with the host's.
 */
import { describe, expect, it } from 'vitest';
import {
	editedHostRecord,
	hostedAgentEditSession,
	HOSTED_SAVE_ARGS,
} from '../../../../renderer/components/HostedAgentSettings/HostedAgentSettingsModal';
import {
	EDIT_AGENT_SAVE_ARG_NAMES,
	readEditAgentSaveArgs,
	type EditAgentSaveArgs,
} from '../../../../renderer/components/NewInstanceModal/types';
import { AGENT_PATCH_FEDERATION } from '../../../../shared/maestro-lib/agents/lift-settings-sync';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';

/** Save arguments with the named ones set, at the positions the editor sends them. */
function saveArgs(fields: Partial<Record<(typeof EDIT_AGENT_SAVE_ARG_NAMES)[number], unknown>>) {
	const args = new Array(EDIT_AGENT_SAVE_ARG_NAMES.length).fill(undefined) as unknown[];
	EDIT_AGENT_SAVE_ARG_NAMES.forEach((name, index) => {
		if (name in fields) args[index] = fields[name];
	});
	return args as EditAgentSaveArgs;
}

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

describe('editedHostRecord on the acappella editor', () => {
	it('reads the control mode at its own position, not the gateway URL before it', () => {
		const edited = editedHostRecord(
			host,
			saveArgs({
				sessionId: 'box:h1',
				name: 'Docs',
				gatewayUrl: 'http://127.0.0.1:9999',
				harnessControlMode: 'native',
			})
		);
		expect(edited.harnessControlMode).toBe('native');
		// A Local Models gateway is this machine's: it never reaches the host record.
		expect(edited).not.toHaveProperty('gatewayUrl');
	});

	it('carries the Peers tab onto the host record, in the host ids the editor lists', () => {
		const edited = editedHostRecord(
			host,
			saveArgs({
				sessionId: 'box:h1',
				name: 'Docs',
				peerGrants: {
					peerAgents: [{ sessionId: 'h2', read: true, write: false, description: ' api ' }],
					groupPeerAccess: { read: true, write: true },
					peerDescription: '  Owns the docs  ',
				},
			})
		);
		expect(edited).toMatchObject({
			peerAgents: [{ sessionId: 'h2', read: true, write: false, description: 'api' }],
			groupPeerAccess: { read: true, write: true },
			peerDescription: 'Owns the docs',
		});
		expect(edited).not.toHaveProperty('worktreePeerAccess');
	});
});

describe('HOSTED_SAVE_ARGS', () => {
	it('decides every save argument, and a host argument names only shared fields', () => {
		expect(Object.keys(HOSTED_SAVE_ARGS).sort()).toEqual([...EDIT_AGENT_SAVE_ARG_NAMES].sort());
		for (const rule of Object.values(HOSTED_SAVE_ARGS)) {
			if (rule.kind !== 'host') continue;
			for (const field of rule.fields) {
				expect(AGENT_PATCH_FEDERATION[field as keyof typeof AGENT_PATCH_FEDERATION]?.scope).toBe(
					'shared'
				);
			}
		}
	});
});

describe('readEditAgentSaveArgs', () => {
	it('names each argument by its position', () => {
		const fields = readEditAgentSaveArgs(
			saveArgs({ sessionId: 's1', convertProviderHistory: true, harnessControlMode: 'native' })
		);
		expect(fields.sessionId).toBe('s1');
		expect(fields.convertProviderHistory).toBe(true);
		expect(fields.harnessControlMode).toBe('native');
		expect(fields.gatewayUrl).toBeUndefined();
	});
});
