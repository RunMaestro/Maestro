/**
 * @file SshRemotesSection.test.tsx
 * @description The SSH Hosts list renders alphabetically by name and narrows
 * through the filter box, matching on name or `user@host:port`.
 */

import '@testing-library/jest-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { SshRemoteConfig } from '../../../../shared/types';

vi.mock('../SshRemoteModal', () => ({ SshRemoteModal: () => null }));

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

import { SshRemotesSection, sortSshRemotes, matchesSshRemoteFilter } from '../SshRemotesSection';
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
