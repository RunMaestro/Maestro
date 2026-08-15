import { describe, expect, it, vi } from 'vitest';
import { buildProviderAuthCommands } from '../../../../../renderer/components/QuickActionsModal/commands/providerAuthCommands';
import type { BlockedIdentity } from '../../../../../renderer/stores/providerAuthStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../../../shared/providerAuth';

const identity = (key: string, label: string): CredentialIdentity => ({
	key,
	provider: 'claude-code',
	kind: 'oauth',
	scope: key,
	host: 'local',
	label,
});

const snapshot = (id: CredentialIdentity): ProviderAuthSnapshot => ({
	identity: id,
	status: 'logged-out',
	checkedAt: 1,
	source: 'probe',
});

const blocked = (key: string, label: string, sessionIds: string[]): BlockedIdentity => {
	const id = identity(key, label);
	return { identity: id, snapshot: snapshot(id), sessionIds };
};

function harness(blockedIdentities: BlockedIdentity[]) {
	const openAuthRecovery = vi.fn();
	const refreshAllIdentities = vi.fn().mockResolvedValue(undefined);
	const setQuickActionOpen = vi.fn();
	const actions = buildProviderAuthCommands({
		blockedIdentities,
		openAuthRecovery,
		refreshAllIdentities,
		setQuickActionOpen,
	});
	return { actions, openAuthRecovery, refreshAllIdentities, setQuickActionOpen };
}

describe('buildProviderAuthCommands', () => {
	it('offers the re-probe command with nothing signed out', () => {
		// Searched for by name after a user fixes a login in their own terminal.
		const { actions } = harness([]);
		expect(actions.map((a) => a.id)).toEqual(['provider-auth-recheck-all']);
	});

	it('offers one entry per credential, not per blocked agent', () => {
		// Fifteen agents on one dead login are one problem and one command.
		const { actions } = harness([blocked('k1', '.claude-gmail', ['s1', 's2', 's3'])]);
		const recovery = actions.filter((a) => a.id.startsWith('provider-auth-recovery-'));
		expect(recovery).toHaveLength(1);
		expect(recovery[0].subtext).toContain('3 agents blocked');
	});

	it('names the account in the label so a multi-account user picks the right one', () => {
		const { actions } = harness([
			blocked('k1', '.claude-gmail', ['s1']),
			blocked('k2', '.claude-smash', ['s2']),
		]);
		const labels = actions.map((a) => a.label);
		expect(labels).toContain('Sign In to Claude Code (.claude-gmail)');
		expect(labels).toContain('Sign In to Claude Code (.claude-smash)');
	});

	it('opens the recovery flow for the identity the entry names', () => {
		const { actions, openAuthRecovery, setQuickActionOpen } = harness([
			blocked('k1', '.claude-gmail', ['s1']),
			blocked('k2', '.claude-smash', ['s2']),
		]);
		void actions.find((a) => a.id === 'provider-auth-recovery-k2')?.action();
		expect(openAuthRecovery).toHaveBeenCalledWith('k2');
		expect(openAuthRecovery).not.toHaveBeenCalledWith('k1');
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('singularizes the blocked count for a lone agent', () => {
		const { actions } = harness([blocked('k1', '.claude', ['s1'])]);
		expect(actions[0].subtext).toContain('1 agent blocked');
	});

	it('re-probes every identity and closes the palette without waiting', () => {
		const { actions, refreshAllIdentities, setQuickActionOpen } = harness([]);
		void actions[0].action();
		expect(refreshAllIdentities).toHaveBeenCalledTimes(1);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});
});
