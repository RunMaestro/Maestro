import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SshRemoteSelector } from '../../renderer/components/shared/SshRemoteSelector';
import type { Theme } from '../../renderer/types';
import type { SshRemoteConfig } from '../../shared/types';

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#111111',
		bgActivity: '#181818',
		border: '#333333',
		textMain: '#f4f4f4',
		textDim: '#999999',
		accent: '#4f9cff',
		accentDim: '#1c4c7a',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const remote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Build Box',
	host: 'build.example.com',
	port: 22,
	username: 'dev',
	privateKeyPath: '/keys/build',
	enabled: true,
};

describe('SshRemoteSelector', () => {
	it('renders compact remote status and keeps select clicks inside the component', () => {
		const onChange = vi.fn();
		const onParentClick = vi.fn();

		render(
			<div onClick={onParentClick}>
				<SshRemoteSelector
					theme={theme}
					sshRemotes={[remote]}
					sshRemoteConfig={{ enabled: true, remoteId: 'remote-1' }}
					onSshRemoteConfigChange={onChange}
					compact
				/>
			</div>
		);

		expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
		expect(screen.getByText('Build Box')).toBeInTheDocument();
		expect(screen.getByText('(build.example.com)')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('combobox'));

		expect(onParentClick).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('switches between remote execution and local execution', () => {
		const onChange = vi.fn();

		render(
			<SshRemoteSelector
				theme={theme}
				sshRemotes={[remote, { ...remote, id: 'disabled', name: 'Disabled', enabled: false }]}
				onSshRemoteConfigChange={onChange}
			/>
		);

		const selector = screen.getByRole('combobox');
		expect(screen.getByText('Agent will run locally')).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /Disabled/ })).not.toBeInTheDocument();

		fireEvent.change(selector, { target: { value: 'remote-1' } });
		fireEvent.change(selector, { target: { value: 'local' } });

		expect(onChange).toHaveBeenNthCalledWith(1, {
			enabled: true,
			remoteId: 'remote-1',
			shareHistoryToProjectDir: undefined,
			syncHistory: false,
			workingDirOverride: undefined,
		});
		expect(onChange).toHaveBeenNthCalledWith(2, {
			enabled: false,
			remoteId: null,
			shareHistoryToProjectDir: undefined,
			syncHistory: undefined,
			workingDirOverride: undefined,
		});
	});

	it('shows the settings hint when no enabled remotes are configured', () => {
		render(
			<SshRemoteSelector
				theme={theme}
				sshRemotes={[{ ...remote, enabled: false }]}
				onSshRemoteConfigChange={vi.fn()}
			/>
		);

		expect(screen.getByText(/No SSH remotes configured/)).toBeInTheDocument();
		expect(screen.getByText(/Configure remotes in Settings/)).toBeInTheDocument();
	});
});
