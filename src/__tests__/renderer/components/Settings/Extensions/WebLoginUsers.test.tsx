/**
 * Web Login account management (the Web Login tile's Settings body).
 *
 * What these defend:
 * - the list renders who exists, when they last signed in, and which accounts
 *   are disabled,
 * - a bad password is refused CLIENT-side, so the store is never asked and the
 *   user gets the reason in the same words,
 * - a successful create clears the form and re-reads the list (a stale list
 *   after a create reads as the account not having been made),
 * - delete is two-step,
 * - the empty state warns, because enabling the flag with no accounts locks
 *   the web interface out,
 * - with the flag OFF the tile says so instead of offering account management
 *   nothing would consult.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { WebLoginUsers } from '../../../../../renderer/components/Settings/Extensions/WebLoginUsers';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import {
	BUILTIN_FEATURES,
	builtinExtension,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { EncoreFeatureFlags, Theme } from '../../../../../renderer/types';

const notifyToast = vi.fn();
vi.mock('../../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));

const theme = {
	colors: {
		textMain: '#eee',
		textDim: '#999',
		bgMain: '#111',
		bgActivity: '#222',
		accent: '#4af',
		border: '#333',
		warning: '#fa0',
		error: '#f44',
		success: '#4f4',
	},
} as unknown as Theme;

const ADA = {
	id: 'u1',
	username: 'ada',
	displayName: 'Ada Lovelace',
	createdAt: Date.now() - 60_000,
	lastLoginAt: Date.now() - 30_000,
};
const GRACE = {
	id: 'u2',
	username: 'grace',
	displayName: 'Grace',
	createdAt: Date.now() - 120_000,
	disabled: true,
};

const webLogin = {
	listUsers: vi.fn(),
	createUser: vi.fn(),
	setPassword: vi.fn(),
	setDisplayName: vi.fn(),
	setDisabled: vi.fn(),
	deleteUser: vi.fn(),
};

function type(testId: string, value: string): void {
	fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe('WebLoginUsers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		webLogin.listUsers.mockResolvedValue([ADA, GRACE]);
		webLogin.createUser.mockResolvedValue({ ...ADA, id: 'u3', username: 'linus' });
		webLogin.setPassword.mockResolvedValue(undefined);
		webLogin.setDisabled.mockResolvedValue(GRACE);
		webLogin.deleteUser.mockResolvedValue(undefined);
		(window as unknown as { maestro: unknown }).maestro = { webLogin };
	});

	afterEach(() => {
		cleanup();
	});

	it('lists every account with its username and disabled state', async () => {
		render(<WebLoginUsers theme={theme} />);

		await waitFor(() => expect(screen.getAllByTestId('web-login-user-row')).toHaveLength(2));
		expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
		expect(screen.getByText(/ada/)).toBeInTheDocument();
		// The disabled badge rides only the disabled account.
		expect(screen.getAllByTestId('web-login-disabled-badge')).toHaveLength(1);
		// The LAN warning is unconditional - it is true whether or not anyone
		// has signed in yet.
		expect(screen.getByTestId('web-login-warning')).toHaveTextContent('plain HTTP');
		expect(screen.getByTestId('web-login-warning')).toHaveTextContent(
			'maestro-cli is never asked to log in'
		);
	});

	it('warns when there are no accounts, because nobody can sign in', async () => {
		webLogin.listUsers.mockResolvedValue([]);
		render(<WebLoginUsers theme={theme} />);

		await waitFor(() =>
			expect(screen.getByTestId('web-login-empty')).toHaveTextContent(
				'No accounts yet. Until you add one, nobody can sign in.'
			)
		);
	});

	it('refuses a short password client-side and never calls the store', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalled());

		type('web-login-new-username', 'linus');
		type('web-login-new-password', 'short');
		type('web-login-new-confirm', 'short');
		fireEvent.click(screen.getByTestId('web-login-create'));

		await waitFor(() =>
			expect(screen.getByTestId('web-login-create-error')).toHaveTextContent(
				'at least 8 characters'
			)
		);
		expect(webLogin.createUser).not.toHaveBeenCalled();
	});

	it('refuses a mismatched confirmation', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalled());

		type('web-login-new-username', 'linus');
		type('web-login-new-password', 'correcthorse');
		type('web-login-new-confirm', 'correcthorseX');
		fireEvent.click(screen.getByTestId('web-login-create'));

		await waitFor(() =>
			expect(screen.getByTestId('web-login-create-error')).toHaveTextContent('do not match')
		);
		expect(webLogin.createUser).not.toHaveBeenCalled();
	});

	it('refuses an invalid username client-side', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalled());

		type('web-login-new-username', 'a');
		type('web-login-new-password', 'correcthorse');
		type('web-login-new-confirm', 'correcthorse');
		fireEvent.click(screen.getByTestId('web-login-create'));

		await waitFor(() => expect(screen.getByTestId('web-login-create-error')).toBeInTheDocument());
		expect(webLogin.createUser).not.toHaveBeenCalled();
	});

	it('creates an account, clears the form, re-reads the list and says so', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalledTimes(1));

		type('web-login-new-username', 'linus');
		type('web-login-new-display-name', 'Linus');
		type('web-login-new-password', 'correcthorse');
		type('web-login-new-confirm', 'correcthorse');
		fireEvent.click(screen.getByTestId('web-login-create'));

		await waitFor(() =>
			expect(webLogin.createUser).toHaveBeenCalledWith({
				username: 'linus',
				password: 'correcthorse',
				displayName: 'Linus',
			})
		);
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalledTimes(2));
		expect((screen.getByTestId('web-login-new-username') as HTMLInputElement).value).toBe('');
		expect((screen.getByTestId('web-login-new-password') as HTMLInputElement).value).toBe('');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'green', title: 'Web Login' })
		);
	});

	it('omits an empty display name so the store falls back to the username', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalled());

		type('web-login-new-username', 'linus');
		type('web-login-new-password', 'correcthorse');
		type('web-login-new-confirm', 'correcthorse');
		fireEvent.click(screen.getByTestId('web-login-create'));

		await waitFor(() =>
			expect(webLogin.createUser).toHaveBeenCalledWith({
				username: 'linus',
				password: 'correcthorse',
			})
		);
	});

	it('shows the store rejection inline rather than a generic failure', async () => {
		webLogin.createUser.mockRejectedValueOnce(
			new Error(
				'Error invoking remote method \'webLogin:createUser\': Error: An account named "linus" already exists.'
			)
		);
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalled());

		type('web-login-new-username', 'linus');
		type('web-login-new-password', 'correcthorse');
		type('web-login-new-confirm', 'correcthorse');
		fireEvent.click(screen.getByTestId('web-login-create'));

		await waitFor(() =>
			expect(screen.getByTestId('web-login-create-error')).toHaveTextContent(
				'An account named "linus" already exists.'
			)
		);
	});

	it('deletes only after a confirmation step', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(screen.getAllByTestId('web-login-user-row')).toHaveLength(2));

		fireEvent.click(screen.getAllByTestId('web-login-delete')[0]);
		expect(webLogin.deleteUser).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('web-login-delete-confirm'));
		await waitFor(() => expect(webLogin.deleteUser).toHaveBeenCalledWith('u1'));
		await waitFor(() => expect(webLogin.listUsers).toHaveBeenCalledTimes(2));
	});

	it('cancels a pending delete without touching the store', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(screen.getAllByTestId('web-login-user-row')).toHaveLength(2));

		fireEvent.click(screen.getAllByTestId('web-login-delete')[0]);
		fireEvent.click(screen.getByTestId('web-login-delete-cancel'));

		expect(screen.queryByTestId('web-login-delete-confirm')).not.toBeInTheDocument();
		expect(webLogin.deleteUser).not.toHaveBeenCalled();
	});

	it('resets a password from the inline form', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(screen.getAllByTestId('web-login-user-row')).toHaveLength(2));

		fireEvent.click(screen.getAllByTestId('web-login-reset-toggle')[0]);
		type('web-login-reset-password', 'brandnewpassword');
		type('web-login-reset-confirm', 'brandnewpassword');
		fireEvent.click(screen.getByTestId('web-login-reset-submit'));

		await waitFor(() =>
			expect(webLogin.setPassword).toHaveBeenCalledWith('u1', 'brandnewpassword')
		);
		await waitFor(() =>
			expect(screen.queryByTestId('web-login-reset-form')).not.toBeInTheDocument()
		);
	});

	it('refuses a reset whose confirmation does not match', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(screen.getAllByTestId('web-login-user-row')).toHaveLength(2));

		fireEvent.click(screen.getAllByTestId('web-login-reset-toggle')[0]);
		type('web-login-reset-password', 'brandnewpassword');
		type('web-login-reset-confirm', 'other-password');
		fireEvent.click(screen.getByTestId('web-login-reset-submit'));

		await waitFor(() =>
			expect(screen.getByTestId('web-login-reset-error')).toHaveTextContent('do not match')
		);
		expect(webLogin.setPassword).not.toHaveBeenCalled();
	});

	it('toggles an account between enabled and disabled', async () => {
		render(<WebLoginUsers theme={theme} />);
		await waitFor(() => expect(screen.getAllByTestId('web-login-user-row')).toHaveLength(2));

		// Row 0 (ada) is enabled, so its button disables.
		fireEvent.click(screen.getAllByTestId('web-login-toggle-disabled')[0]);
		await waitFor(() => expect(webLogin.setDisabled).toHaveBeenCalledWith('u1', true));

		// Row 1 (grace) is disabled, so its button enables.
		fireEvent.click(screen.getAllByTestId('web-login-toggle-disabled')[1]);
		await waitFor(() => expect(webLogin.setDisabled).toHaveBeenCalledWith('u2', false));
	});

	it('surfaces a failed list read instead of showing an empty roster', async () => {
		webLogin.listUsers.mockRejectedValueOnce(new Error('disk on fire'));
		render(<WebLoginUsers theme={theme} />);

		await waitFor(() =>
			expect(screen.getByTestId('web-login-load-error')).toHaveTextContent('disk on fire')
		);
	});
});

describe('Web Login tile body', () => {
	const flags = (enabled: boolean) => ({ webLogin: enabled }) as unknown as EncoreFeatureFlags;

	function renderTile(enabled: boolean): void {
		const def = BUILTIN_FEATURES.find((f) => f.flag === 'webLogin');
		if (!def) throw new Error('no builtin feature for flag webLogin');
		render(
			<ExtensionDetails
				theme={theme}
				ext={builtinExtension(def, flags(enabled))}
				contributions={null}
				busy={false}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
			/>
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		webLogin.listUsers.mockResolvedValue([]);
		(window as unknown as { maestro: unknown }).maestro = { webLogin };
	});

	afterEach(() => {
		cleanup();
	});

	it('manages accounts when the feature is enabled', async () => {
		renderTile(true);
		await waitFor(() => expect(screen.getByTestId('web-login-users')).toBeInTheDocument());
	});

	it('says to enable the feature first when it is off', () => {
		renderTile(false);
		expect(screen.getByTestId('extension-settings-disabled-hint')).toHaveTextContent(
			'Enable Web Login to manage accounts.'
		);
		expect(screen.queryByTestId('web-login-users')).not.toBeInTheDocument();
	});
});
