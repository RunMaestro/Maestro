// Source: src/__tests__/renderer/components/Settings/SshRemoteModal.test.tsx
// Source: src/renderer/components/Settings/__tests__/SshRemotesSection.test.tsx
// Source: src/__tests__/renderer/components/Settings/SshRemediationNotice.test.tsx
import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { SshRemoteModal } from '../../../../renderer/components/Settings/SshRemoteModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import type { SshRemoteConfig } from '../../../../shared/types';
import { SshRemotesSection } from '../../../../renderer/components/Settings/SshRemotesSection';
import { sortSshRemotes } from '../../../../renderer/components/Settings/SshRemotesSection';
import { matchesSshRemoteFilter } from '../../../../renderer/components/Settings/SshRemotesSection';
import { THEMES } from '../../../../renderer/constants/themes';
import { SshRemediationNotice } from '../../../../renderer/components/Settings/SshRemediationNotice';
import { nonPosixRemoteShellRemediation } from '../../../../shared/sshRemoteShell';
const openUrl = vi.fn();
vi.mock('../../../../renderer/utils/openUrl', () => ({
	openUrl: (url: string, options?: { ctrlKey?: boolean }) => openUrl(url, options),
}));

const remote = (id: string, name: string, host: string, username = ''): SshRemoteConfig =>
	({ id, name, host, port: 22, username, privateKeyPath: '', enabled: true }) as SshRemoteConfig;
const configs: SshRemoteConfig[] = [
	remote('1', 'pedtome', 'pedtome-tailcat', 'pedram'),
	remote('2', 'NeeMAC', 'neemac.local'),
	remote('3', 'maestro-ac', 'maestro-ac', 'maestro'),
	remote('4', 'HVM JR', 'jennifer-tailcat', 'Jennifer'),
];
vi.mock('../../../../renderer/hooks', async (importOriginal) => ({
	...(await importOriginal()),
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
describe('SshRemoteModal', () => {
	const existing: SshRemoteConfig = {
		id: 'r1',
		name: 'pedtome',
		host: 'pedtome-tailcat',
		port: 22,
		username: 'pedram',
		privateKeyPath: '',
		enabled: true,
	};

	function renderModal(initialConfig?: SshRemoteConfig) {
		const onSave = vi.fn(async (config: Partial<SshRemoteConfig>) => ({
			success: true,
			config: config as SshRemoteConfig,
		}));
		render(
			<LayerStackProvider>
				<SshRemoteModal
					theme={mockTheme}
					isOpen
					onClose={vi.fn()}
					onSave={onSave}
					initialConfig={initialConfig}
				/>
			</LayerStackProvider>
		);
		return { onSave };
	}

	async function save(onSave: ReturnType<typeof renderModal>['onSave']) {
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		return onSave.mock.calls[0][0];
	}

	let previousMaestro: typeof window.maestro;
	beforeEach(() => {
		previousMaestro = window.maestro;
		(window as unknown as { maestro: unknown }).maestro = {
			...((window as unknown as { maestro?: object }).maestro ?? {}),
			sshRemote: { getSshConfigHosts: vi.fn().mockResolvedValue({ success: true, hosts: [] }) },
		};
	});

	afterEach(() => {
		cleanup();
		window.maestro = previousMaestro;
	});

	describe('SshRemoteModal federation toggle', () => {
		it('is on for a remote with no federation field, and saves nothing for it', async () => {
			const { onSave } = renderModal(existing);
			const toggle = screen.getByRole('switch', { name: 'Federation' });
			expect(toggle).toHaveAttribute('aria-checked', 'true');
			expect((await save(onSave)).federation).toBeUndefined();
		});

		it('saves the opt-out when switched off', async () => {
			const { onSave } = renderModal(existing);
			const toggle = screen.getByRole('switch', { name: 'Federation' });
			fireEvent.click(toggle);
			expect(toggle).toHaveAttribute('aria-checked', 'false');
			expect(await save(onSave)).toMatchObject({ id: 'r1', federation: false });
		});

		it('reflects an existing opt-out and clears it when switched back on', async () => {
			const { onSave } = renderModal({ ...existing, federation: false });
			const toggle = screen.getByRole('switch', { name: 'Federation' });
			expect(toggle).toHaveAttribute('aria-checked', 'false');

			fireEvent.click(toggle);
			expect((await save(onSave)).federation).toBeUndefined();
		});

		it('starts on for a new remote', () => {
			renderModal();
			expect(screen.getByRole('switch', { name: 'Federation' })).toHaveAttribute(
				'aria-checked',
				'true'
			);
		});

		it('still toggles Enable this remote through the shared switch', async () => {
			const { onSave } = renderModal(existing);
			fireEvent.click(screen.getByRole('switch', { name: 'Enable this remote' }));
			expect(await save(onSave)).toMatchObject({ enabled: false });
		});
	});
});
describe('SshRemotesSection', () => {
	const theme = THEMES.dracula;

	const renderedNames = () =>
		screen.queryAllByTestId('ssh-remote-name').map((el) => el.textContent);

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
			render(
				<LayerStackProvider>
					<SshRemotesSection theme={theme} />
				</LayerStackProvider>
			);
			expect(renderedNames()).toEqual(['HVM JR', 'maestro-ac', 'NeeMAC', 'pedtome']);
		});

		it('narrows the list as the filter is typed and reports the match count', () => {
			render(
				<LayerStackProvider>
					<SshRemotesSection theme={theme} />
				</LayerStackProvider>
			);
			fireEvent.change(screen.getByLabelText('Filter SSH remotes'), {
				target: { value: 'tailcat' },
			});
			expect(renderedNames()).toEqual(['HVM JR', 'pedtome']);
			expect(screen.getByText('2 of 4')).toBeInTheDocument();
		});

		it('says so when nothing matches', () => {
			render(
				<LayerStackProvider>
					<SshRemotesSection theme={theme} />
				</LayerStackProvider>
			);
			fireEvent.change(screen.getByLabelText('Filter SSH remotes'), {
				target: { value: 'zzz' },
			});
			expect(renderedNames()).toEqual([]);
			expect(screen.getByText(/No remotes match/)).toBeInTheDocument();
		});
	});
});
describe('SshRemediationNotice', () => {
	describe('SshRemediationNotice', () => {
		beforeEach(() => {
			openUrl.mockClear();
		});

		it('names the shell, explains the block, and shows the fix command', () => {
			const remediation = nonPosixRemoteShellRemediation('powershell', 'PEDSIM');
			render(<SshRemediationNotice remediation={remediation} theme={mockTheme} />);

			expect(screen.getByText(remediation.title)).toBeInTheDocument();
			expect(screen.getByText(/PEDSIM/)).toBeInTheDocument();
			expect(screen.getByText(remediation.command!)).toBeInTheDocument();
			expect(screen.getByText(remediation.commandLabel!)).toBeInTheDocument();
			expect(screen.getByTitle('Copy fix command')).toBeInTheDocument();
		});

		it('opens the docs page rather than navigating the app', () => {
			const remediation = nonPosixRemoteShellRemediation('cmd');
			render(<SshRemediationNotice remediation={remediation} theme={mockTheme} />);

			fireEvent.click(screen.getByText('Setting up a Windows remote host'));

			expect(openUrl).toHaveBeenCalledWith(remediation.docsUrl, { ctrlKey: false });
		});

		it('renders without a command or docs link', () => {
			render(
				<SshRemediationNotice
					remediation={{
						code: 'non-posix-remote-shell',
						title: 'Something went wrong',
						detail: 'A cause with no one-line fix.',
					}}
					theme={mockTheme}
				/>
			);

			expect(screen.getByText('A cause with no one-line fix.')).toBeInTheDocument();
			expect(screen.queryByTitle('Copy fix command')).not.toBeInTheDocument();
			expect(screen.queryByText('Setting up a Windows remote host')).not.toBeInTheDocument();
		});
	});
});
