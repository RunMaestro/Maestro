/**
 * ProviderAccountsSection - the manual entry point into the recovery flow.
 *
 * What is under test is that the panel is honest about each credential: it
 * lists every account whether or not anything is broken, offers a sign-in only
 * where a login can actually repair the credential, and names the env var to
 * change where it cannot.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ProviderAccountsSection } from '../../../../renderer/components/Settings/ProviderAccountsSection';
import { useCenterFlashStore } from '../../../../renderer/stores/centerFlashStore';
import {
	getModalActions,
	selectModalData,
	useModalStore,
} from '../../../../renderer/stores/modalStore';
import { useProviderAuthStore } from '../../../../renderer/stores/providerAuthStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../../shared/providerAuth';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

const HOME = '/Users/x';
const OAUTH_KEY = `claude-code::oauth::${HOME}/.claude::local`;
const KEY_KEY = 'claude-code::api-key::fp_1a2b3c4d::local';

const oauthIdentity: CredentialIdentity = {
	key: OAUTH_KEY,
	provider: 'claude-code',
	kind: 'oauth',
	scope: `${HOME}/.claude`,
	host: 'local',
	configDir: `${HOME}/.claude`,
	label: '.claude',
};

const apiKeyIdentity: CredentialIdentity = {
	key: KEY_KEY,
	provider: 'claude-code',
	kind: 'api-key',
	scope: 'fp_1a2b3c4d',
	host: 'local',
	envVarName: 'ANTHROPIC_API_KEY',
	label: 'Claude Code fp_1a2b3c4d',
};

const snapshot = (
	identity: CredentialIdentity,
	status: ProviderAuthSnapshot['status'],
	extra: Partial<ProviderAuthSnapshot> = {}
): ProviderAuthSnapshot => ({
	identity,
	status,
	checkedAt: Date.now(),
	source: 'probe',
	...extra,
});

function renderSection(overrides: { probeOnStartup?: boolean; onChange?: () => void } = {}) {
	const onChange = overrides.onChange ?? vi.fn();
	render(
		<ProviderAccountsSection
			theme={mockTheme}
			probeOnStartup={overrides.probeOnStartup ?? true}
			onProbeOnStartupChange={onChange}
		/>
	);
	return { onChange };
}

describe('ProviderAccountsSection', () => {
	beforeEach(() => {
		useProviderAuthStore.getState().__resetForTests();
		useSessionStore.setState({ sessions: [] });
		getModalActions().closeAuthRecovery();
		(window as unknown as { maestro: unknown }).maestro = {
			providerAuth: {
				getAll: vi.fn().mockResolvedValue({}),
				onChange: () => () => {},
			},
			agents: { getCustomEnvVars: vi.fn().mockResolvedValue({}) },
			fs: { homeDir: vi.fn().mockResolvedValue(HOME) },
		};
	});

	it('lists an account that is fine, so the flow is reachable before anything breaks', () => {
		useProviderAuthStore.setState({
			loaded: true,
			snapshots: {
				[OAUTH_KEY]: snapshot(oauthIdentity, 'authenticated', {
					accountLabel: 'pedram@example.com',
				}),
			},
		});

		renderSection();

		expect(screen.getByText('Claude Code (.claude)')).toBeInTheDocument();
		expect(screen.getByText('Signed in')).toBeInTheDocument();
		expect(screen.getByText(/pedram@example.com/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Sign In/ })).toBeInTheDocument();
	});

	it('opens the recovery modal for the row that was clicked', () => {
		useProviderAuthStore.setState({
			loaded: true,
			snapshots: { [OAUTH_KEY]: snapshot(oauthIdentity, 'logged-out') },
		});

		renderSection();
		fireEvent.click(screen.getByRole('button', { name: /Sign In/ }));

		expect(selectModalData('authRecovery')(useModalStore.getState())?.identityKey).toBe(OAUTH_KEY);
	});

	it('offers no login for a credential a login cannot repair, and names the env var', () => {
		useProviderAuthStore.setState({
			loaded: true,
			snapshots: { [KEY_KEY]: snapshot(apiKeyIdentity, 'unsupported') },
		});

		renderSection();

		expect(screen.queryByRole('button', { name: /Sign In/ })).not.toBeInTheDocument();
		expect(screen.getByText(/ANTHROPIC_API_KEY was rejected/)).toBeInTheDocument();
		expect(screen.getByText("Can't verify")).toBeInTheDocument();
	});

	it('re-probes one account from its row and every account from the footer', async () => {
		const refreshIdentity = vi.fn().mockResolvedValue({ probed: true, snapshot: null });
		const refreshAllIdentities = vi.fn().mockResolvedValue(undefined);
		useProviderAuthStore.setState({
			loaded: true,
			snapshots: { [OAUTH_KEY]: snapshot(oauthIdentity, 'authenticated') },
			refreshIdentity,
			refreshAllIdentities,
		});

		renderSection();

		fireEvent.click(screen.getByRole('button', { name: /Re-check Claude Code/i }));
		await waitFor(() => expect(refreshIdentity).toHaveBeenCalledWith(OAUTH_KEY));

		fireEvent.click(screen.getByRole('button', { name: /Re-Check All Accounts/i }));
		await waitFor(() => expect(refreshAllIdentities).toHaveBeenCalledTimes(1));
	});

	// A pass that declines to probe still resolves, and the row redisplays the
	// status it already had. Without a signal, the spinner stopping reads as
	// "checked, unchanged" for a check that never happened.
	it('says so when the re-check could not probe anything', async () => {
		const refreshIdentity = vi.fn().mockResolvedValue({ probed: false, snapshot: null });
		useProviderAuthStore.setState({
			loaded: true,
			snapshots: { [OAUTH_KEY]: snapshot(oauthIdentity, 'authenticated') },
			refreshIdentity,
		});

		renderSection();
		fireEvent.click(screen.getByRole('button', { name: /Re-check Claude Code/i }));

		await waitFor(() =>
			expect(useCenterFlashStore.getState().active?.message).toBe('Could not check this account')
		);
		expect(useCenterFlashStore.getState().active?.color).toBe('orange');
	});

	// A record written by an error-pattern match was never checked by anything.
	it('does not claim a check for a credential only an error pattern reported', () => {
		useProviderAuthStore.setState({
			loaded: true,
			snapshots: {
				[OAUTH_KEY]: {
					...snapshot(oauthIdentity, 'logged-out'),
					source: 'error-pattern',
				},
			},
		});

		renderSection();

		expect(screen.queryByText(/Checked /)).not.toBeInTheDocument();
		expect(screen.getByText(/Reported /)).toBeInTheDocument();
	});

	it('lists a credential no probe has answered for yet, resolved from its agents', async () => {
		useSessionStore.setState({ sessions: [createMockSession({ id: 'a', name: 'Alpha' })] });
		await useProviderAuthStore.getState().hydrate();

		renderSection();

		expect(screen.getByText('Claude Code (.claude)')).toBeInTheDocument();
		expect(screen.getByText(/Never checked/)).toBeInTheDocument();
		expect(screen.getByText(/Used by 1 agent/)).toBeInTheDocument();
		// A never-probed credential is still repairable, so the button is offered.
		expect(screen.getByRole('button', { name: /Sign In/ })).toBeInTheDocument();
	});

	it('says so when there is nothing to list', () => {
		useProviderAuthStore.setState({ loaded: true, snapshots: {} });
		renderSection();
		expect(screen.getByText(/No provider accounts have been resolved yet/)).toBeInTheDocument();
	});

	it('toggles the startup probe setting', () => {
		useProviderAuthStore.setState({ loaded: true, snapshots: {} });
		const { onChange } = renderSection({ probeOnStartup: true });

		fireEvent.click(screen.getByRole('switch', { name: 'Check provider logins at startup' }));
		expect(onChange).toHaveBeenCalledWith(false);
	});
});
