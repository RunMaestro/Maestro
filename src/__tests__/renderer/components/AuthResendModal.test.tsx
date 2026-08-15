/**
 * AuthResendModal - the confirmation that stands between a repaired login and
 * the user's old prompts going back out.
 *
 * What matters here is that the modal cannot mislead: every prompt it will send
 * is named on screen, and both exits that are NOT "send" (the button, Escape,
 * the ESC pill) decline. A modal that sent on Escape would replay work the user
 * was trying to walk away from.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AuthResendModal, type AuthResendRow } from '../../../renderer/components/AuthResendModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { CredentialIdentity } from '../../../shared/providerAuth';
import { mockTheme } from '../../helpers/mockTheme';

const identity: CredentialIdentity = {
	key: 'claude-code::oauth::/Users/x/.claude-gmail::local',
	provider: 'claude-code',
	kind: 'oauth',
	scope: '/Users/x/.claude-gmail',
	host: 'local',
	label: '.claude-gmail',
};

const rows: AuthResendRow[] = [
	{
		key: 'a:a-tab',
		agentName: 'parser',
		tabName: 'main',
		preview: 'refactor the tokenizer',
		failedAt: 1_000,
	},
	{
		key: 'b:b-tab',
		agentName: 'docs',
		tabName: 'draft',
		preview: 'write the release note',
		failedAt: 2_000,
	},
];

function renderModal(overrides: Partial<React.ComponentProps<typeof AuthResendModal>> = {}) {
	const onResend = vi.fn();
	const onDecline = vi.fn();
	render(
		<LayerStackProvider>
			<AuthResendModal
				identity={identity}
				rows={rows}
				theme={mockTheme}
				onResend={onResend}
				onDecline={onDecline}
				{...overrides}
			/>
		</LayerStackProvider>
	);
	return { onResend, onDecline };
}

describe('AuthResendModal', () => {
	beforeEach(() => {
		cleanup();
	});

	it('names the account and every prompt it would resend', () => {
		renderModal();

		expect(screen.getByTestId('auth-resend-modal')).toBeInTheDocument();
		expect(screen.getByText(/\.claude-gmail/)).toBeInTheDocument();
		expect(screen.getAllByTestId('auth-resend-row')).toHaveLength(2);
		expect(screen.getByText('refactor the tokenizer')).toBeInTheDocument();
		expect(screen.getByText('write the release note')).toBeInTheDocument();
		expect(screen.getByText('parser')).toBeInTheDocument();
	});

	it('counts the prompts on the confirm button', () => {
		renderModal();
		expect(screen.getByTestId('auth-resend-confirm').textContent).toContain('Resend all 2');
	});

	it('speaks singular for a single prompt', () => {
		renderModal({ rows: [rows[0]] });
		expect(screen.getByTestId('auth-resend-confirm').textContent).toContain('Resend it');
	});

	it('sends only when the user says so', () => {
		const { onResend, onDecline } = renderModal();

		fireEvent.click(screen.getByTestId('auth-resend-confirm'));

		expect(onResend).toHaveBeenCalledTimes(1);
		expect(onDecline).not.toHaveBeenCalled();
	});

	it('declines through "Not now"', () => {
		const { onResend, onDecline } = renderModal();

		fireEvent.click(screen.getByTestId('auth-resend-decline'));

		expect(onDecline).toHaveBeenCalledTimes(1);
		expect(onResend).not.toHaveBeenCalled();
	});

	it('declines through the ESC pill and through Escape - never sends on the way out', () => {
		const { onResend, onDecline } = renderModal();

		fireEvent.click(screen.getByTestId('auth-resend-esc'));
		fireEvent.keyDown(document, { key: 'Escape' });

		expect(onDecline).toHaveBeenCalled();
		expect(onResend).not.toHaveBeenCalled();
	});
});
