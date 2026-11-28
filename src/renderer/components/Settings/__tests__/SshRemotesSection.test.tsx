/**
 * @file SshRemotesSection.test.tsx
 * @description The SSH Hosts list renders alphabetically by name and narrows
 * through the filter box, matching on name or `user@host:port`.
 */

import '@testing-library/jest-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { SshRemoteConfig } from '../../../../shared/types';

// The editor renders nothing; its last props are kept, so a test can save through it.
const modalProps: {
	current?: { isOpen: boolean; onSave: (config: Partial<SshRemoteConfig>) => Promise<unknown> };
} = {};
vi.mock('../SshRemoteModal', () => ({
	SshRemoteModal: (props: NonNullable<typeof modalProps.current>) => {
		modalProps.current = props;
		return null;
	},
}));

// The confirmation as plain markup: what it says, and its two buttons.
vi.mock('../../ConfirmModal', () => ({
	ConfirmModal: (props: {
		title: string;
		message: string;
		confirmLabel: string;
		onConfirm: () => void;
		onClose: () => void;
	}) => (
		<div role="dialog" aria-label={props.title}>
			<p>{props.message}</p>
			<button
				type="button"
				onClick={() => {
					props.onConfirm();
					props.onClose();
				}}
			>
				{props.confirmLabel}
			</button>
			<button type="button" onClick={props.onClose}>
				Cancel
			</button>
		</div>
	),
}));

const stopRemoteHostFromWindow = vi.fn();
vi.mock('../../../services/agentLift', () => ({
	stopRemoteHostFromWindow: (...args: unknown[]) => stopRemoteHostFromWindow(...args),
}));

const remote = (id: string, name: string, host: string, username = ''): SshRemoteConfig =>
	({ id, name, host, port: 22, username, privateKeyPath: '', enabled: true }) as SshRemoteConfig;

const configs: SshRemoteConfig[] = [
	remote('1', 'pedtome', 'pedtome-tailcat', 'pedram'),
	remote('2', 'NeeMAC', 'neemac.local'),
	remote('3', 'maestro-ac', 'maestro-ac', 'maestro'),
	remote('4', 'HVM JR', 'jennifer-tailcat', 'Jennifer'),
];

const refresh = vi.fn(async () => {});
const saveConfig = vi.fn(async (_config: Partial<SshRemoteConfig>) => ({ success: true }));
vi.mock('../../../hooks', () => ({
	useSshRemotes: () => ({
		configs,
		defaultId: '1',
		loading: false,
		error: null,
		saveConfig: (config: Partial<SshRemoteConfig>) => saveConfig(config),
		deleteConfig: vi.fn(),
		setDefaultId: vi.fn(),
		testConnection: vi.fn(),
		testingConfigId: null,
		refresh,
	}),
}));

import {
	SshRemotesSection,
	sortSshRemotes,
	matchesSshRemoteFilter,
	removeHostConfirmMessage,
} from '../SshRemotesSection';
import { THEMES } from '../../../constants/themes';

const theme = THEMES.dracula;

const renderedNames = () => screen.queryAllByTestId('ssh-remote-name').map((el) => el.textContent);

afterEach(cleanup);

describe('sortSshRemotes', () => {
	it('orders by name case-insensitively without mutating the input', () => {
		const input = [...configs];
		expect(sortSshRemotes(input).map((c) => c.name)).toEqual([
			'HVM JR',
			'maestro-ac',
			'NeeMAC',
			'pedtome',
		]);
		expect(input).toEqual(configs);
	});
});

describe('matchesSshRemoteFilter', () => {
	it('matches name or connection target, ignoring case and surrounding space', () => {
		expect(matchesSshRemoteFilter(configs[1], '  neem ')).toBe(true);
		expect(matchesSshRemoteFilter(configs[3], 'jennifer@')).toBe(true);
		expect(matchesSshRemoteFilter(configs[3], 'proxmox')).toBe(false);
		expect(matchesSshRemoteFilter(configs[3], '   ')).toBe(true);
	});
});

describe('SshRemotesSection', () => {
	it('renders remotes alphabetically', () => {
		render(<SshRemotesSection theme={theme} />);
		expect(renderedNames()).toEqual(['HVM JR', 'maestro-ac', 'NeeMAC', 'pedtome']);
	});

	it('narrows the list as the filter is typed and reports the match count', () => {
		render(<SshRemotesSection theme={theme} />);
		fireEvent.change(screen.getByLabelText('Filter SSH remotes'), {
			target: { value: 'tailcat' },
		});
		expect(renderedNames()).toEqual(['HVM JR', 'pedtome']);
		expect(screen.getByText('2 of 4')).toBeInTheDocument();
	});

	it('says so when nothing matches', () => {
		render(<SshRemotesSection theme={theme} />);
		fireEvent.change(screen.getByLabelText('Filter SSH remotes'), {
			target: { value: 'zzz' },
		});
		expect(renderedNames()).toEqual([]);
		expect(screen.getByText(/No remotes match/)).toBeInTheDocument();
	});
});

describe('Stop Host and Remove Host', () => {
	const rowOf = (name: string) =>
		screen
			.getAllByTestId('ssh-remote-name')
			.find((el) => el.textContent === name)!
			.closest('.rounded.border') as HTMLElement;

	afterEach(() => stopRemoteHostFromWindow.mockReset());

	it('says what is removed before it removes anything, and calls the same stop with uninstall', async () => {
		stopRemoteHostFromWindow.mockResolvedValue({
			ok: true,
			outcome: 'done',
			message: 'The host on NeeMAC is stopped.',
			federationOff: true,
		});
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('NeeMAC')).getByLabelText('Remove Host'));
		const dialog = screen.getByRole('dialog', { name: 'Remove Host' });
		expect(dialog).toHaveTextContent(removeHostConfirmMessage('NeeMAC'));
		expect(removeHostConfirmMessage('NeeMAC')).toContain('~/.maestro');
		expect(removeHostConfirmMessage('NeeMAC')).toContain(
			"keeps ~/.maestro/host.env, any maestro-cli Maestro did not install, and the host's data directory"
		);
		// Everything that goes, the boot service files included, and what --force does to agents.
		expect(removeHostConfirmMessage('NeeMAC')).toContain(
			'~/.config/systemd/user/maestro-host.service and its default.target.wants link'
		);
		expect(removeHostConfirmMessage('NeeMAC')).toContain(
			'~/Library/LaunchAgents/sh.maestro.host.plist'
		);
		expect(removeHostConfirmMessage('NeeMAC')).toContain(
			'removing it anyway leaves those agents behind on the remote, with no host to run them'
		);
		expect(stopRemoteHostFromWindow).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByText('Remove Host'));
		await waitFor(() =>
			expect(screen.getByTestId('ssh-remote-host-result')).toHaveTextContent(
				'The host on NeeMAC is stopped.'
			)
		);
		expect(stopRemoteHostFromWindow).toHaveBeenCalledWith('2', { uninstall: true, force: false });
		// The remote's Federation switch changed in main: the list reloads so an edit keeps it off.
		expect(refresh).toHaveBeenCalled();
	});

	it('asks again, naming the agents, before it stops a host that holds them', async () => {
		stopRemoteHostFromWindow
			.mockResolvedValueOnce({
				ok: true,
				outcome: 'agents-held',
				message: 'The host on pedtome holds 1 agent: "Backend". Nothing was changed.',
				agents: [{ id: 'a1', name: 'Backend' }],
			})
			.mockResolvedValueOnce({
				ok: true,
				outcome: 'done',
				message: 'The host on pedtome is stopped.',
			});
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('pedtome')).getByLabelText('Stop Host'));
		fireEvent.click(
			within(screen.getByRole('dialog', { name: 'Stop Host' })).getByText('Stop Host')
		);
		const again = await screen.findByText(
			/holds 1 agent: "Backend"\. Nothing was changed\. Stopping it anyway leaves those agents behind on the remote until a host runs there again\. Stop it anyway\?/
		);
		expect(stopRemoteHostFromWindow).toHaveBeenLastCalledWith('1', {
			uninstall: false,
			force: false,
		});

		fireEvent.click(
			within(again.closest('[role="dialog"]') as HTMLElement).getByText('Stop Anyway')
		);
		await waitFor(() =>
			expect(stopRemoteHostFromWindow).toHaveBeenLastCalledWith('1', {
				uninstall: false,
				force: true,
			})
		);
		expect(await screen.findByTestId('ssh-remote-host-result')).toHaveTextContent('is stopped');
	});

	it('warns that removing anyway leaves the agents behind with no host to run them', async () => {
		stopRemoteHostFromWindow.mockResolvedValueOnce({
			ok: true,
			outcome: 'agents-held',
			message: 'The host on pedtome holds 1 agent: "Backend". Nothing was changed.',
			agents: [{ id: 'a1', name: 'Backend' }],
		});
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('pedtome')).getByLabelText('Remove Host'));
		fireEvent.click(
			within(screen.getByRole('dialog', { name: 'Remove Host' })).getByText('Remove Host')
		);
		expect(
			await screen.findByText(
				/Removing it anyway leaves those agents behind on the remote, with no host to run them\. Remove it anyway\?/
			)
		).toBeInTheDocument();
	});

	it('shows a boot service that could not be disabled as a failure, and reloads the switch', async () => {
		stopRemoteHostFromWindow.mockResolvedValue({
			ok: false,
			code: 'service-disable',
			error: 'Its boot service could not be disabled, so the host comes back at the next boot.',
			federationOff: true,
		});
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('HVM JR')).getByLabelText('Stop Host'));
		fireEvent.click(
			within(screen.getByRole('dialog', { name: 'Stop Host' })).getByText('Stop Host')
		);
		await waitFor(() =>
			expect(screen.getByTestId('ssh-remote-host-result')).toHaveTextContent(
				'comes back at the next boot'
			)
		);
		expect(refresh).toHaveBeenCalled();
	});

	it('keeps Federation off when an editor opened before the stop saves the value it opened with', async () => {
		stopRemoteHostFromWindow.mockResolvedValue({
			ok: true,
			outcome: 'done',
			message: 'The host on NeeMAC is stopped.',
			federationOff: true,
		});
		saveConfig.mockClear();
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('NeeMAC')).getByTitle('Edit'));
		fireEvent.click(within(rowOf('NeeMAC')).getByLabelText('Stop Host'));
		fireEvent.click(
			within(screen.getByRole('dialog', { name: 'Stop Host' })).getByText('Stop Host')
		);
		await waitFor(() => expect(screen.getByTestId('ssh-remote-host-result')).toBeInTheDocument());
		// The editor still holds Federation on, as it was opened: its save must not switch it back.
		await modalProps.current!.onSave({ ...configs[1], federation: undefined });
		expect(saveConfig).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: '2', federation: false })
		);
	});

	it('saves Federation as edited when no stop ran while the editor was open', async () => {
		saveConfig.mockClear();
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('NeeMAC')).getByTitle('Edit'));
		await modalProps.current!.onSave({ ...configs[1], federation: undefined });
		expect(saveConfig).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: '2', federation: undefined })
		);
	});

	it('shows a failure on the row', async () => {
		stopRemoteHostFromWindow.mockResolvedValue({
			ok: false,
			code: 'ssh-failed',
			error: 'No route to host.',
		});
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('HVM JR')).getByLabelText('Stop Host'));
		fireEvent.click(
			within(screen.getByRole('dialog', { name: 'Stop Host' })).getByText('Stop Host')
		);
		expect(await screen.findByTestId('ssh-remote-host-result')).toHaveTextContent(
			'No route to host.'
		);
	});
});
