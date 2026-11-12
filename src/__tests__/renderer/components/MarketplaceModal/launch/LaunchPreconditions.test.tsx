/**
 * Tests for LaunchPreconditions: the requirements, the maestro-cli row and the confirmation.
 *
 * The gate (`evaluateLaunchGate`) owns the wording of a block or a skipped step, so these tests
 * hand the component gates with recognizable strings and pin which row shows them, with or
 * without an Install button.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LaunchPreconditions } from '../../../../../renderer/components/MarketplaceModal/launch/LaunchPreconditions';
import type { LaunchGate } from '../../../../../renderer/components/MarketplaceModal/launch/launchAgents';
import type { MaestroCliState } from '../../../../../renderer/hooks/utils/useMaestroCliState';
import type { PlaybookLaunchSpec } from '../../../../../shared/marketplace-types';
import type { MaestroCliStatus } from '../../../../../shared/maestro-cli';
import { mockTheme } from '../../../../helpers/mockTheme';

type Preconditions = PlaybookLaunchSpec['preconditions'];

const OPEN_GATE: LaunchGate = { available: true, notes: [] };
const REQUIRED_MISSING: LaunchGate = {
	available: false,
	cliReason: 'REQUIRED: maestro-cli is not installed.',
	notes: [],
};
const OPTIONAL_MISSING: LaunchGate = {
	available: true,
	notes: ['OPTIONAL: steps that call maestro-cli are skipped.'],
};

const INSTALLED: MaestroCliStatus = {
	expectedVersion: '1.0.0',
	installed: true,
	inPath: true,
	inShellPath: false,
	commandPath: '/home/me/.local/bin/maestro-cli',
	installedVersion: '1.0.0',
	versionMatch: true,
	needsInstallOrUpdate: false,
	installDir: '/home/me/.local/bin',
	bundledCliPath: '/app/maestro-cli.js',
};
const NOT_INSTALLED: MaestroCliStatus = {
	...INSTALLED,
	installed: false,
	inPath: false,
	commandPath: null,
	installedVersion: null,
	needsInstallOrUpdate: true,
};

function cliState(overrides: Partial<MaestroCliState> = {}): MaestroCliState {
	return {
		status: null,
		statusError: null,
		checking: false,
		installing: false,
		installMessage: null,
		restartRequired: false,
		checkStatus: vi.fn().mockResolvedValue(undefined),
		installOrUpdate: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

interface RenderOptions {
	preconditions?: Preconditions;
	gate?: LaunchGate;
	maestroCli?: MaestroCliState;
	remote?: boolean;
	confirmed?: boolean;
	disabled?: boolean;
}

function renderPreconditions(options: RenderOptions = {}) {
	const onConfirmedChange = vi.fn();
	const maestroCli = options.maestroCli ?? cliState();
	const view = render(
		<LaunchPreconditions
			theme={mockTheme}
			preconditions={options.preconditions}
			gate={options.gate ?? OPEN_GATE}
			maestroCli={maestroCli}
			remote={options.remote ?? false}
			confirmed={options.confirmed ?? false}
			onConfirmedChange={onConfirmedChange}
			disabled={options.disabled}
		/>
	);
	return { onConfirmedChange, maestroCli, ...view };
}

describe('LaunchPreconditions', () => {
	describe('what it draws', () => {
		it('draws nothing when the playbook declares no preconditions and can launch here', () => {
			const { container } = renderPreconditions({ preconditions: undefined });

			expect(container).toBeEmptyDOMElement();
		});

		it('draws nothing for an empty preconditions block', () => {
			const { container } = renderPreconditions({ preconditions: { requires: [] } });

			expect(container).toBeEmptyDOMElement();
		});

		it('lists what the playbook requires', () => {
			renderPreconditions({
				preconditions: { requires: ['gh logged in', 'React web project'] },
			});

			const items = screen.getAllByRole('listitem').map((item) => item.textContent);
			expect(items).toEqual(['gh logged in', 'React web project']);
			expect(screen.getByText('Requirements')).toBeInTheDocument();
		});

		it('says why the playbook cannot launch on this machine', () => {
			renderPreconditions({
				preconditions: { platforms: ['darwin'] },
				gate: { available: false, blockedReason: 'This playbook runs on macOS only.', notes: [] },
			});

			expect(screen.getByTestId('launch-blocked-reason')).toHaveTextContent(
				'This playbook runs on macOS only.'
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('hides the maestro-cli row for a playbook that cannot launch here at all', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: { available: false, blockedReason: 'This playbook runs on macOS only.', notes: [] },
				maestroCli: cliState({ status: NOT_INSTALLED }),
			});

			expect(screen.queryByTestId('launch-maestro-cli-row')).not.toBeInTheDocument();
			expect(screen.queryByTestId('launch-install-maestro-cli')).not.toBeInTheDocument();
		});
	});

	describe('the confirmation', () => {
		it('shows the playbook text as a checkbox', () => {
			renderPreconditions({ preconditions: { confirm: 'I understand this reads my Messages.' } });

			expect(
				screen.getByRole('checkbox', { name: /I understand this reads my Messages\./ })
			).not.toBeChecked();
		});

		it('shows it ticked once the person ticked it', () => {
			renderPreconditions({ preconditions: { confirm: 'Sure?' }, confirmed: true });

			expect(screen.getByRole('checkbox')).toBeChecked();
		});

		it('reports the tick', () => {
			const { onConfirmedChange } = renderPreconditions({ preconditions: { confirm: 'Sure?' } });

			fireEvent.click(screen.getByRole('checkbox'));

			expect(onConfirmedChange).toHaveBeenCalledWith(true);
		});

		it('is disabled while a launch is starting', () => {
			renderPreconditions({ preconditions: { confirm: 'Sure?' }, disabled: true });

			expect(screen.getByRole('checkbox')).toBeDisabled();
		});

		it('has no checkbox when the playbook asks for no confirmation', () => {
			renderPreconditions({ preconditions: { requires: ['gh logged in'] } });

			expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
		});
	});

	describe('the maestro-cli row on an agent on this machine', () => {
		it('says it is checking while the install state is unread', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: REQUIRED_MISSING,
				maestroCli: cliState({ status: null, checking: true }),
			});

			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
				'Checking whether maestro-cli is installed...'
			);
			expect(screen.queryByTestId('launch-install-maestro-cli')).not.toBeInTheDocument();
			expect(screen.queryByText(/REQUIRED:/)).not.toBeInTheDocument();
		});

		it('warns and offers Install when a required maestro-cli is missing', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: REQUIRED_MISSING,
				maestroCli: cliState({ status: NOT_INSTALLED }),
			});

			const row = screen.getByTestId('launch-maestro-cli-row');
			expect(row).toHaveAttribute('role', 'alert');
			expect(row).toHaveTextContent('REQUIRED: maestro-cli is not installed.');
			expect(screen.getByRole('button', { name: 'Install maestro-cli' })).toBeEnabled();
		});

		it('runs the install when Install is pressed', () => {
			const maestroCli = cliState({ status: NOT_INSTALLED });
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: REQUIRED_MISSING,
				maestroCli,
			});

			fireEvent.click(screen.getByRole('button', { name: 'Install maestro-cli' }));

			expect(maestroCli.installOrUpdate).toHaveBeenCalledTimes(1);
		});

		it('only informs, and still offers Install, when an optional maestro-cli is missing', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'optional' },
				gate: OPTIONAL_MISSING,
				maestroCli: cliState({ status: NOT_INSTALLED }),
			});

			const row = screen.getByTestId('launch-maestro-cli-row');
			expect(row).toHaveAttribute('role', 'status');
			expect(row).toHaveTextContent('OPTIONAL: steps that call maestro-cli are skipped.');
			expect(screen.getByRole('button', { name: 'Install maestro-cli' })).toBeInTheDocument();
		});

		it('shows the install as running and blocks a second press', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: REQUIRED_MISSING,
				maestroCli: cliState({ status: NOT_INSTALLED, installing: true }),
			});

			expect(screen.getByRole('button', { name: 'Installing...' })).toBeDisabled();
		});

		it('blocks Install while a launch is starting', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: REQUIRED_MISSING,
				maestroCli: cliState({ status: NOT_INSTALLED }),
				disabled: true,
			});

			expect(screen.getByRole('button', { name: 'Install maestro-cli' })).toBeDisabled();
		});

		it('says it is installed and drops the button', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: OPEN_GATE,
				maestroCli: cliState({ status: INSTALLED }),
			});

			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
				'maestro-cli is installed.'
			);
			expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
		});

		it('explains who sees a changed PATH after an install that changed it', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				maestroCli: cliState({ status: INSTALLED, restartRequired: true }),
			});

			const row = screen.getByTestId('launch-maestro-cli-row');
			expect(row).toHaveTextContent(
				'Only terminal windows opened from now on see the change. Agents Maestro starts already get the updated PATH.'
			);
		});

		it('adds no restart note when the PATH was left alone', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				maestroCli: cliState({ status: INSTALLED, restartRequired: false }),
			});

			expect(screen.getByTestId('launch-maestro-cli-row')).not.toHaveTextContent(
				'terminal windows'
			);
		});

		it('shows an install that finished but still needs attention', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: REQUIRED_MISSING,
				maestroCli: cliState({
					status: NOT_INSTALLED,
					installMessage: {
						text: 'CLI was installed but version/path check still needs attention.',
						ok: false,
					},
				}),
			});

			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
				'CLI was installed but version/path check still needs attention.'
			);
		});

		it('shows a failed check and keeps Install available as the retry', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: REQUIRED_MISSING,
				maestroCli: cliState({ status: null, statusError: 'Failed to check Maestro CLI status' }),
			});

			const row = screen.getByTestId('launch-maestro-cli-row');
			expect(row).toHaveTextContent('Failed to check Maestro CLI status');
			expect(screen.getByRole('button', { name: 'Install maestro-cli' })).toBeInTheDocument();
		});

		it('draws no row for a playbook that does not mention maestro-cli', () => {
			renderPreconditions({
				preconditions: { requires: ['gh logged in'] },
				maestroCli: cliState({ status: NOT_INSTALLED }),
			});

			expect(screen.queryByTestId('launch-maestro-cli-row')).not.toBeInTheDocument();
		});
	});

	describe('the maestro-cli row on an agent on an SSH remote', () => {
		const remoteRequired: LaunchGate = {
			available: false,
			cliReason: 'REMOTE: not available on remote agents.',
			notes: [],
		};
		const remoteOptional: LaunchGate = {
			available: true,
			notes: ['REMOTE NOTE: steps that call maestro-cli are skipped.'],
		};

		it('warns with the reason and offers no Install when maestro-cli is required', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: remoteRequired,
				remote: true,
				maestroCli: cliState({ status: INSTALLED }),
			});

			const row = screen.getByTestId('launch-maestro-cli-row');
			expect(row).toHaveAttribute('role', 'alert');
			expect(row).toHaveTextContent('REMOTE: not available on remote agents.');
			expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
		});

		it('names the skipped steps and offers no Install when maestro-cli is optional', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'optional' },
				gate: remoteOptional,
				remote: true,
			});

			const row = screen.getByTestId('launch-maestro-cli-row');
			expect(row).toHaveAttribute('role', 'status');
			expect(row).toHaveTextContent('REMOTE NOTE: steps that call maestro-cli are skipped.');
			expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
		});

		it('does not wait for an install state it will never read', () => {
			renderPreconditions({
				preconditions: { maestroCli: 'required' },
				gate: remoteRequired,
				remote: true,
				maestroCli: cliState({ status: null, statusError: null }),
			});

			expect(screen.getByTestId('launch-maestro-cli-row')).not.toHaveTextContent('Checking');
		});
	});
});
