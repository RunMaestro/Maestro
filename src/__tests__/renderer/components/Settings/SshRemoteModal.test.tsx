import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SshRemoteModal } from '../../../../renderer/components/Settings/SshRemoteModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../renderer/types';
import type { SshRemoteConfig } from '../../../../shared/types';

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#374151',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#2563eb',
		accentForeground: '#ffffff',
		border: '#4b5563',
		error: '#ef4444',
		success: '#10b981',
		warning: '#f59e0b',
		info: '#38bdf8',
		textInverse: '#020617',
	},
};

const sshConfigHosts = [
	{
		host: 'dev-box',
		hostName: 'dev.internal',
		port: 2200,
		user: 'ubuntu',
		identityFile: '~/.ssh/dev_ed25519',
	},
	{
		host: 'backup',
		hostName: 'backup.internal',
		port: 22,
		user: 'deploy',
	},
];

const originalSshRemote = window.maestro?.sshRemote;

function renderModal(overrides: Partial<React.ComponentProps<typeof SshRemoteModal>> = {}) {
	const props: React.ComponentProps<typeof SshRemoteModal> = {
		theme,
		isOpen: true,
		onClose: vi.fn(),
		onSave: vi.fn().mockResolvedValue({ success: true }),
		onTestConnection: vi.fn().mockResolvedValue({
			success: true,
			result: { success: true, remoteInfo: { hostname: 'dev-host' } },
		}),
		...overrides,
	};

	return {
		...render(<SshRemoteModal {...props} />, { wrapper: LayerStackProvider }),
		props,
	};
}

describe('SshRemoteModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.maestro = {
			...window.maestro,
			sshRemote: {
				...window.maestro?.sshRemote,
				getSshConfigHosts: vi.fn().mockResolvedValue({
					success: true,
					hosts: sshConfigHosts,
				}),
			},
		};
	});

	afterEach(() => {
		cleanup();
		window.maestro = {
			...window.maestro,
			sshRemote: originalSshRemote,
		};
		vi.restoreAllMocks();
	});

	it('returns null when closed and loads SSH config hosts when opened for a new remote', async () => {
		const { rerender, props } = renderModal({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(window.maestro.sshRemote.getSshConfigHosts).not.toHaveBeenCalled();

		rerender(<SshRemoteModal {...props} isOpen />);

		expect(screen.getByRole('dialog', { name: 'Add SSH Remote' })).toBeInTheDocument();
		await waitFor(() => {
			expect(window.maestro.sshRemote.getSshConfigHosts).toHaveBeenCalledOnce();
		});
		expect(await screen.findByText('2 hosts found in ~/.ssh/config')).toBeInTheDocument();
	});

	it('imports an SSH config host, supports filtering, tests connection, and saves the config', async () => {
		const onSave = vi.fn().mockResolvedValue({ success: true });
		const onClose = vi.fn();
		const onTestConnection = vi.fn().mockResolvedValue({
			success: true,
			result: { success: true, remoteInfo: { hostname: 'dev-host' } },
		});

		renderModal({ onSave, onClose, onTestConnection });

		fireEvent.click(await screen.findByRole('button', { name: /Select a host to import/i }));
		const filterInput = screen.getByPlaceholderText('Type to filter...');
		fireEvent.change(filterInput, { target: { value: 'missing' } });
		expect(screen.getByText('No hosts match filter')).toBeInTheDocument();

		fireEvent.change(filterInput, { target: { value: 'dev' } });
		fireEvent.keyDown(filterInput, { key: 'Enter' });

		expect(screen.getByText(/Imported from:/)).toBeInTheDocument();
		expect(screen.getAllByDisplayValue('dev-box')).toHaveLength(2);
		expect(screen.getByDisplayValue('2200')).toBeInTheDocument();
		expect(screen.getByDisplayValue('ubuntu')).toBeInTheDocument();
		expect(screen.getByDisplayValue('~/.ssh/dev_ed25519')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		await screen.findByText('Connection successful!');
		expect(screen.getByText('Remote hostname: dev-host')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => {
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					id: '',
					name: 'dev-box',
					host: 'dev-box',
					port: 2200,
					username: 'ubuntu',
					privateKeyPath: '~/.ssh/dev_ed25519',
					useSshConfig: true,
					sshConfigHost: 'dev-box',
					enabled: true,
				})
			);
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('supports SSH config dropdown keyboard, mouse, summary, and click-away behavior', async () => {
		vi.mocked(window.maestro.sshRemote.getSshConfigHosts).mockResolvedValueOnce({
			success: true,
			hosts: [
				{ host: 'host-only', hostName: 'host-only.internal', identityFile: '~/.ssh/' },
				{ host: 'user-only', user: 'deploy' },
				{ host: 'no-details' },
			],
		});
		renderModal();

		fireEvent.click(await screen.findByRole('button', { name: /Select a host to import/i }));

		expect(screen.getByText('host-only.internal, key: ~/.ssh/')).toBeInTheDocument();
		expect(screen.getByText('deploy@...')).toBeInTheDocument();
		expect(screen.getByText('No details available')).toBeInTheDocument();

		const filterInput = screen.getByPlaceholderText('Type to filter...');
		fireEvent.mouseDown(screen.getByRole('listbox', { name: 'SSH config hosts' }));
		expect(screen.getByRole('listbox', { name: 'SSH config hosts' })).toBeInTheDocument();
		fireEvent.keyDown(filterInput, { key: 'Tab' });
		fireEvent.keyDown(filterInput, { key: 'ArrowUp' });
		fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
		fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
		fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
		fireEvent.change(filterInput, { target: { value: 'absent' } });
		fireEvent.keyDown(filterInput, { key: 'Enter' });
		expect(screen.getByText('No hosts match filter')).toBeInTheDocument();
		fireEvent.change(filterInput, { target: { value: '' } });

		fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Manual Name' } });
		fireEvent.click(screen.getByRole('button', { name: /host-only/i }));
		expect(screen.getByDisplayValue('Manual Name')).toBeInTheDocument();
		expect(screen.getByDisplayValue('host-only')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Stop tracking SSH config origin'));
		fireEvent.click(screen.getByRole('button', { name: /Select a host to import/i }));
		const userOnlyFilterInput = screen.getByPlaceholderText('Type to filter...');
		fireEvent.keyDown(userOnlyFilterInput, { key: 'ArrowDown' });
		fireEvent.keyDown(userOnlyFilterInput, { key: 'ArrowUp' });
		const userOnlyOption = await screen.findByRole('button', { name: /user-only/i });
		fireEvent.mouseEnter(userOnlyOption);
		fireEvent.click(userOnlyOption);

		expect(screen.getByText(/Imported from:/)).toBeInTheDocument();
		expect(screen.getByDisplayValue('Manual Name')).toBeInTheDocument();
		expect(screen.getByDisplayValue('user-only')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Stop tracking SSH config origin'));
		fireEvent.click(screen.getByRole('button', { name: /Select a host to import/i }));
		expect(screen.getByRole('listbox', { name: 'SSH config hosts' })).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('listbox', { name: 'SSH config hosts' })).not.toBeInTheDocument();
	});

	it('edits an existing remote with environment variables and disabled state', async () => {
		const onSave = vi.fn().mockResolvedValue({ success: true });
		const initialConfig: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Existing Remote',
			host: 'existing.internal',
			port: 2222,
			username: 'alice',
			privateKeyPath: '~/.ssh/existing',
			remoteEnv: {
				FOO: 'bar',
			},
			enabled: true,
			useSshConfig: true,
			sshConfigHost: 'existing',
		};

		renderModal({
			initialConfig,
			title: 'Custom Edit Title',
			onSave,
			onTestConnection: undefined,
		});

		expect(screen.getByRole('dialog', { name: 'Custom Edit Title' })).toBeInTheDocument();
		expect(window.maestro.sshRemote.getSshConfigHosts).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue('FOO')).toBeInTheDocument();
		expect(screen.getByDisplayValue('bar')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Remove variable'));
		fireEvent.click(screen.getByRole('button', { name: /Add Variable/i }));
		fireEvent.click(screen.getByRole('button', { name: /Add Variable/i }));
		const variableInputs = screen.getAllByPlaceholderText('VARIABLE');
		const valueInputs = screen.getAllByPlaceholderText('value');
		fireEvent.change(variableInputs[0], { target: { value: 'NODE_ENV' } });
		fireEvent.change(valueInputs[0], { target: { value: 'test' } });
		fireEvent.change(valueInputs[1], { target: { value: 'ignored-without-key' } });

		fireEvent.click(screen.getByTitle('Stop tracking SSH config origin'));
		const enabledSection = screen.getByText('Enable this remote').closest('.flex');
		expect(enabledSection).toBeTruthy();
		fireEvent.click(within(enabledSection as HTMLElement).getByRole('button'));

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => {
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'remote-1',
					name: 'Existing Remote',
					host: 'existing.internal',
					port: 2222,
					username: 'alice',
					privateKeyPath: '~/.ssh/existing',
					remoteEnv: { NODE_ENV: 'test' },
					enabled: false,
					useSshConfig: false,
					sshConfigHost: undefined,
				})
			);
		});
	});

	it('edits an existing remote without environment variables', () => {
		const initialConfig: SshRemoteConfig = {
			id: 'remote-no-env',
			name: 'No Env Remote',
			host: 'no-env.internal',
			port: 22,
			username: '',
			privateKeyPath: '',
			enabled: true,
		};

		renderModal({
			initialConfig,
			onTestConnection: undefined,
		});

		expect(screen.getByDisplayValue('No Env Remote')).toBeInTheDocument();
		expect(screen.queryByPlaceholderText('VARIABLE')).not.toBeInTheDocument();
		expect(screen.queryByText(/Imported from:/)).not.toBeInTheDocument();
	});

	it('handles failed SSH config host loading and singular host copy', async () => {
		vi.mocked(window.maestro.sshRemote.getSshConfigHosts)
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({
				success: true,
				hosts: [{ host: 'solo', hostName: 'solo.internal' }],
			})
			.mockRejectedValueOnce(new Error('Cannot read SSH config'));

		renderModal();

		await waitFor(() => {
			expect(window.maestro.sshRemote.getSshConfigHosts).toHaveBeenCalledOnce();
		});
		expect(
			screen.queryByRole('button', { name: /Select a host to import/i })
		).not.toBeInTheDocument();

		cleanup();
		renderModal();

		expect(await screen.findByText('1 host found in ~/.ssh/config')).toBeInTheDocument();

		cleanup();
		renderModal();

		await waitFor(() => {
			expect(window.maestro.sshRemote.getSshConfigHosts).toHaveBeenCalledTimes(3);
		});
		expect(
			screen.queryByRole('button', { name: /Select a host to import/i })
		).not.toBeInTheDocument();
	});

	it('shows save and test failures without closing the modal', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn().mockResolvedValue({ success: false, error: 'Save failed' });
		const onTestConnection = vi
			.fn()
			.mockResolvedValueOnce({ success: false, error: 'Connection refused' })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error('Network timeout'))
			.mockRejectedValueOnce('bad failure');

		renderModal({ onClose, onSave, onTestConnection });

		fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Bad Remote' } });
		fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'bad.internal' } });

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		expect(await screen.findByText('Connection refused')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		expect(await screen.findByText('Connection failed')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		expect(await screen.findByText('Network timeout')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		expect(await screen.findByText('Connection test failed')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Save failed')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('uses fallback save errors for missing messages and non-Error throws', async () => {
		const onClose = vi.fn();
		const onSave = vi
			.fn()
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce('bad failure');

		renderModal({ onClose, onSave });

		fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Fallback Save' } });
		fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'fallback.internal' } });

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Failed to save configuration')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Failed to save configuration')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('surfaces thrown save failures without closing the modal', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn().mockRejectedValue(new Error('Disk offline'));

		renderModal({ onClose, onSave });

		fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Broken Save' } });
		fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'broken.internal' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(await screen.findByText('Disk offline')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('surfaces validation state for missing fields and invalid ports', async () => {
		renderModal();
		await screen.findByText('2 hosts found in ~/.ssh/config');

		const saveButton = screen.getByRole('button', { name: 'Save' });
		const testButton = screen.getByRole('button', { name: 'Test Connection' });

		expect(saveButton).toBeDisabled();
		expect(testButton).toBeDisabled();

		fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Port Test' } });
		fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'host.internal' } });
		expect(saveButton).toBeEnabled();

		fireEvent.change(screen.getByLabelText('Port'), { target: { value: '70000' } });
		expect(saveButton).toBeDisabled();
		expect(testButton).toBeDisabled();

		fireEvent.change(screen.getByLabelText('Port'), { target: { value: '22' } });
		expect(saveButton).toBeEnabled();
		expect(testButton).toBeEnabled();
	});
});
