/**
 * @file SshRemotesSection.test.tsx
 * @description The SSH Hosts list renders alphabetically by name and narrows
 * through the filter box, matching on name or `user@host:port`.
 */

import '@testing-library/jest-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { SshRemoteConfig } from '../../../../shared/types';

vi.mock('../SshRemoteModal', () => ({ SshRemoteModal: () => null }));

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

vi.mock('../../../hooks', () => ({
	useSshRemotes: () => ({
		configs,
		defaultId: '1',
		loading: false,
		error: null,
		saveConfig: vi.fn(),
		deleteConfig: vi.fn(),
		setDefaultId: vi.fn(),
		testConnection: vi.fn(),
		testingConfigId: null,
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
		});
		render(<SshRemotesSection theme={theme} />);
		fireEvent.click(within(rowOf('NeeMAC')).getByLabelText('Remove Host'));
		const dialog = screen.getByRole('dialog', { name: 'Remove Host' });
		expect(dialog).toHaveTextContent(removeHostConfirmMessage('NeeMAC'));
		expect(removeHostConfirmMessage('NeeMAC')).toContain('~/.maestro');
		expect(removeHostConfirmMessage('NeeMAC')).toContain(
			"keeps ~/.maestro/host.env, any maestro-cli Maestro did not install, and the host's data directory"
		);
		expect(stopRemoteHostFromWindow).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByText('Remove Host'));
		await waitFor(() =>
			expect(screen.getByTestId('ssh-remote-host-result')).toHaveTextContent(
				'The host on NeeMAC is stopped.'
			)
		);
		expect(stopRemoteHostFromWindow).toHaveBeenCalledWith('2', { uninstall: true, force: false });
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
			/holds 1 agent: "Backend"\. Nothing was changed\. Stop it anyway\?/
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
