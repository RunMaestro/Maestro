/**
 * Tests for AccountSwitcherModal: accounts are labeled by the signed-in email,
 * the account to move to is marked when the current one is spent, a click
 * switches the agent, and an agent that cannot switch is told why.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AccountSwitcherModal } from '../../../renderer/components/AccountSwitcherModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useClaudeUsageStore } from '../../../renderer/stores/claudeUsageStore';
import { createMockSession } from '../../helpers';
import { mockTheme } from '../../helpers/mockTheme';
import type { Session } from '../../../renderer/types';

const HOME = '/home/testuser';
const LATER = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

function seed(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 's1',
		name: 'Builder',
		customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-a` },
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

function renderModal(session: Session, onClose = vi.fn()) {
	render(
		<LayerStackProvider>
			<AccountSwitcherModal theme={mockTheme} session={session} onClose={onClose} />
		</LayerStackProvider>
	);
	return onClose;
}

beforeEach(() => {
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockResolvedValue(null);
	vi.mocked(window.maestro.agents.carryProviderSession).mockResolvedValue('shared');
	vi.mocked(window.maestro.agents.getProviderAccounts).mockResolvedValue([
		{ accountKey: `${HOME}/.claude-a`, email: 'a@x.com', signedIn: true },
		{ accountKey: `${HOME}/.claude-b`, email: 'b@x.com', signedIn: true },
		{ accountKey: `${HOME}/.claude-c`, signedIn: false },
	]);
	useSettingsStore.setState({ shellEnvVars: {} });
	useClaudeUsageStore.setState({
		loaded: true,
		snapshots: {
			[`${HOME}/.claude-a`]: {
				sampledAt: new Date().toISOString(),
				configDirKey: `${HOME}/.claude-a`,
				session: { percent: 100, resetsAt: LATER },
				weekAllModels: { percent: 40 },
				weekSonnetOnly: { percent: 0 },
			},
		},
	});
});

describe('AccountSwitcherModal', () => {
	it('labels accounts by email and suggests the one that can run now', async () => {
		renderModal(seed());

		expect(await screen.findByText('b@x.com')).toBeInTheDocument();
		expect(screen.getByText('a@x.com')).toBeInTheDocument();
		expect(screen.getByText('Current')).toBeInTheDocument();
		expect(screen.getByText('Suggested')).toBeInTheDocument();
		expect(screen.getByText(/Spent, reopens in/)).toBeInTheDocument();
		expect(screen.getByText('Not signed in')).toBeInTheDocument();
	});

	it('switches the agent on click and closes', async () => {
		const onClose = renderModal(seed());

		fireEvent.click(await screen.findByText('b@x.com'));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(useSessionStore.getState().sessions[0].customEnvVars).toEqual({
			CLAUDE_CONFIG_DIR: `${HOME}/.claude-b`,
		});
	});

	it('explains why an API-key agent cannot switch', async () => {
		renderModal(seed({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-1' } }));
		expect(await screen.findByTestId('account-switcher-blocked')).toHaveTextContent(
			/ANTHROPIC_API_KEY/
		);
	});
});
