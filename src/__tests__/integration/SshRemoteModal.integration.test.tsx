import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SshRemoteModal } from '../../renderer/components/Settings/SshRemoteModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';
import type { SshRemoteConfig } from '../../shared/types';

const theme: Theme = {
	id: 'custom',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#242424',
		border: '#334155',
		textMain: '#f8fafc',
		textDim: '#94a3b8',
		accent: '#38bdf8',
		accentDim: '#0e7490',
		accentText: '#38bdf8',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function renderModal(props: Partial<React.ComponentProps<typeof SshRemoteModal>> = {}) {
	return render(
		<LayerStackProvider>
			<SshRemoteModal
				theme={theme}
				isOpen
				onClose={vi.fn()}
				onSave={vi.fn().mockResolvedValue({ success: true })}
				{...props}
			/>
		</LayerStackProvider>
	);
}

function sshConfig(overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig {
	return {
		id: 'remote-1',
		name: 'Existing Remote',
		host: 'existing-host',
		port: 2222,
		username: 'existing-user',
		privateKeyPath: '~/.ssh/existing',
		enabled: true,
		remoteEnv: { EXISTING_TOKEN: 'abc123' },
		useSshConfig: true,
		sshConfigHost: 'existing-alias',
		...overrides,
	};
}

describe('SshRemoteModal integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.sshRemote.getSshConfigHosts).mockResolvedValue({
			success: true,
			configPath: '~/.ssh/config',
			hosts: [
				{
					host: 'dev-box',
					hostName: 'dev.example.com',
					user: 'devuser',
					port: 22,
					identityFile: '~/.ssh/dev',
				},
				{
					host: 'prod-box',
					hostName: 'prod.example.com',
					user: 'deploy',
					port: 2222,
					identityFile: '~/.ssh/prod',
				},
			],
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('returns null when closed and handles SSH config summary, keyboard, and click-away paths', async () => {
		const { rerender } = renderModal({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(window.maestro.sshRemote.getSshConfigHosts).not.toHaveBeenCalled();

		vi.mocked(window.maestro.sshRemote.getSshConfigHosts).mockResolvedValueOnce({
			success: true,
			configPath: '~/.ssh/config',
			hosts: [
				{ host: 'host-only', hostName: 'host-only.internal' },
				{ host: 'user-only', user: 'deploy' },
				{ host: 'no-details' },
			],
		});
		rerender(
			<LayerStackProvider>
				<SshRemoteModal
					theme={theme}
					isOpen
					onClose={vi.fn()}
					onSave={vi.fn().mockResolvedValue({ success: true })}
				/>
			</LayerStackProvider>
		);

		fireEvent.click(await screen.findByRole('button', { name: /Select a host to import/i }));
		expect(screen.getByText('host-only.internal')).toBeInTheDocument();
		expect(screen.getByText('deploy@...')).toBeInTheDocument();
		expect(screen.getByText('No details available')).toBeInTheDocument();

		const filterInput = screen.getByPlaceholderText('Type to filter...');
		fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
		fireEvent.keyDown(filterInput, { key: 'ArrowUp' });
		fireEvent.change(filterInput, { target: { value: 'absent' } });
		fireEvent.keyDown(filterInput, { key: 'Enter' });
		expect(screen.getByText('No hosts match filter')).toBeInTheDocument();

		fireEvent.change(filterInput, { target: { value: '' } });
		const userOnlyOption = screen.getByRole('button', { name: /user-only/i });
		fireEvent.mouseEnter(userOnlyOption);
		fireEvent.keyDown(filterInput, { key: 'Enter' });
		expect(screen.getByText(/Imported from:/)).toBeInTheDocument();
		expect(screen.getByLabelText('Host')).toHaveValue('user-only');

		fireEvent.click(screen.getByTitle('Stop tracking SSH config origin'));
		fireEvent.click(screen.getByRole('button', { name: /Select a host to import/i }));
		expect(screen.getByRole('listbox', { name: 'SSH config hosts' })).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('listbox', { name: 'SSH config hosts' })).not.toBeInTheDocument();
	});

	it('silently ignores SSH config loading failures', async () => {
		vi.mocked(window.maestro.sshRemote.getSshConfigHosts).mockRejectedValueOnce(
			new Error('Cannot read SSH config')
		);

		renderModal();

		await waitFor(() => expect(window.maestro.sshRemote.getSshConfigHosts).toHaveBeenCalledOnce());
		expect(
			screen.queryByRole('button', { name: /Select a host to import/i })
		).not.toBeInTheDocument();
		expect(screen.getByRole('dialog', { name: 'Add SSH Remote' })).toBeInTheDocument();
	});

	it('imports an SSH config host, tests it, saves env vars, and closes on success', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn().mockResolvedValue({ success: true });
		const onTestConnection = vi.fn().mockResolvedValue({
			success: true,
			result: { success: true, remoteInfo: { hostname: 'prod-host' } },
		});

		renderModal({ onClose, onSave, onTestConnection });

		expect(await screen.findByText('2 hosts found in ~/.ssh/config')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Select a host to import/i }));
		fireEvent.change(screen.getByPlaceholderText('Type to filter...'), {
			target: { value: 'prod' },
		});
		fireEvent.click(screen.getByText('prod-box'));

		expect(screen.getByLabelText('Display Name')).toHaveValue('prod-box');
		expect(screen.getByLabelText('Host')).toHaveValue('prod-box');
		expect(screen.getByLabelText('Port')).toHaveValue('2222');
		expect(screen.getByLabelText('Username (optional)')).toHaveValue('deploy');
		expect(screen.getByLabelText('Private Key Path (optional)')).toHaveValue('~/.ssh/prod');
		expect(screen.getByText(/Imported from:/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		await waitFor(() =>
			expect(onTestConnection).toHaveBeenCalledWith(
				expect.objectContaining({
					host: 'prod-box',
					useSshConfig: true,
					sshConfigHost: 'prod-box',
				})
			)
		);
		expect(await screen.findByText('Connection successful!')).toBeInTheDocument();
		expect(screen.getByText('Remote hostname: prod-host')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Add Variable/i }));
		fireEvent.change(screen.getByPlaceholderText('VARIABLE'), {
			target: { value: 'DEPLOY_ENV' },
		});
		fireEvent.change(screen.getByPlaceholderText('value'), {
			target: { value: 'production' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					id: '',
					name: 'prod-box',
					host: 'prod-box',
					port: 2222,
					username: 'deploy',
					privateKeyPath: '~/.ssh/prod',
					enabled: true,
					useSshConfig: true,
					sshConfigHost: 'prod-box',
					remoteEnv: { DEPLOY_ENV: 'production' },
				})
			)
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('validates required fields and displays connection and save failures', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn().mockResolvedValue({ success: false, error: 'Name already exists' });
		const onTestConnection = vi.fn().mockResolvedValue({
			success: false,
			error: 'Permission denied',
		});

		renderModal({ onClose, onSave, onTestConnection });

		const saveButton = screen.getByRole('button', { name: 'Save' });
		const testButton = screen.getByRole('button', { name: 'Test Connection' });
		expect(saveButton).toBeDisabled();
		expect(testButton).toBeDisabled();

		fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Broken' } });
		fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'broken.example.com' } });
		fireEvent.change(screen.getByLabelText('Port'), { target: { value: '70000' } });
		expect(saveButton).toBeDisabled();

		fireEvent.change(screen.getByLabelText('Port'), { target: { value: '22' } });
		expect(saveButton).not.toBeDisabled();
		expect(testButton).not.toBeDisabled();

		fireEvent.click(testButton);
		expect(await screen.findByText('Permission denied')).toBeInTheDocument();

		fireEvent.click(saveButton);
		expect(await screen.findByText('Name already exists')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('surfaces thrown connection and save failures without closing', async () => {
		const onClose = vi.fn();
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new Error('Disk offline'))
			.mockRejectedValueOnce('bad failure');
		const onTestConnection = vi
			.fn()
			.mockRejectedValueOnce(new Error('Network timeout'))
			.mockRejectedValueOnce('bad failure');

		renderModal({ onClose, onSave, onTestConnection });

		fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Broken' } });
		fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'broken.example.com' } });

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		expect(await screen.findByText('Network timeout')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		expect(await screen.findByText('Connection test failed')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Disk offline')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Failed to save configuration')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('edits existing configs without loading SSH hosts and can remove imported/env state', async () => {
		const onSave = vi.fn().mockResolvedValue({ success: true });
		const onClose = vi.fn();

		renderModal({ onSave, onClose, initialConfig: sshConfig() });

		expect(window.maestro.sshRemote.getSshConfigHosts).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog', { name: 'Edit SSH Remote' })).toBeInTheDocument();
		expect(screen.getByLabelText('Display Name')).toHaveValue('Existing Remote');
		expect(screen.getByLabelText('Host')).toHaveValue('existing-host');
		expect(screen.getByPlaceholderText('VARIABLE')).toHaveValue('EXISTING_TOKEN');
		expect(screen.getByPlaceholderText('value')).toHaveValue('abc123');

		fireEvent.click(screen.getByTitle('Stop tracking SSH config origin'));
		expect(screen.queryByText(/Imported from:/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Remove variable'));
		expect(screen.queryByPlaceholderText('VARIABLE')).not.toBeInTheDocument();

		const enabledToggle = screen.getByText('Enable this remote').parentElement?.parentElement
			?.lastElementChild as HTMLButtonElement | undefined;
		expect(enabledToggle).toBeInstanceOf(HTMLButtonElement);
		fireEvent.click(enabledToggle!);

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'remote-1',
					name: 'Existing Remote',
					host: 'existing-host',
					port: 2222,
					enabled: false,
					remoteEnv: undefined,
					useSshConfig: false,
					sshConfigHost: undefined,
				})
			)
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('edits existing configs without environment variables', () => {
		renderModal({
			initialConfig: sshConfig({
				id: 'remote-no-env',
				name: 'No Env Remote',
				remoteEnv: undefined,
				useSshConfig: false,
				sshConfigHost: undefined,
			}),
			onTestConnection: undefined,
		});

		expect(screen.getByRole('dialog', { name: 'Edit SSH Remote' })).toBeInTheDocument();
		expect(screen.getByLabelText('Display Name')).toHaveValue('No Env Remote');
		expect(screen.queryByPlaceholderText('VARIABLE')).not.toBeInTheDocument();
		expect(screen.queryByText(/Imported from:/)).not.toBeInTheDocument();
	});
});
