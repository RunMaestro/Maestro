/**
 * Tests for CoworkingSetup component
 *
 * Tests the Coworking settings panel including:
 * - Install status fetch on mount and per-agent rows (name + config path)
 * - Install vs Uninstall button per row install state
 * - Browser interaction switch bound to coworkingBrowserInteraction membership
 * - Ask-before-actions radiogroup with direct policy selection (no cycling)
 * - Policy description text switching per selected policy
 * - "Never asks" warning shown only when interaction is on AND policy is 'off'
 * - Background browsing switch and conditional Limit input
 * - getInstallStatus rejection surfaces a toast instead of crashing
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CoworkingSetup } from '../../../../renderer/components/Settings/CoworkingSetup';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

import { mockTheme } from '../../../helpers/mockTheme';

const mockNotifyToast = vi.fn();
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

// Exact user-facing copy the component contracts to render. Duplicated here on
// purpose: the component does not export these, and the visible wording is the
// behavior under test.
const DANGEROUS_DESCRIPTION =
	'Asks before risky actions: navigating, running JavaScript, typing into fields, opening or closing tabs.';
const ALL_DESCRIPTION = 'Asks before every browser action, including clicks and screenshots.';
const OFF_DESCRIPTION =
	'Only asks before running JavaScript (always required); every other action runs immediately.';
const WARNING_TEXT = 'This agent can drive your browser without ever asking you.';

interface InstallStatusRow {
	agentId: string;
	configPath: string;
	installed: boolean;
}

const installedClaude: InstallStatusRow = {
	agentId: 'claude-code',
	configPath: '/home/user/.claude.json',
	installed: true,
};

const uninstalledCodex: InstallStatusRow = {
	agentId: 'codex',
	configPath: '/home/user/.codex/config.toml',
	installed: false,
};

describe('CoworkingSetup', () => {
	let mockGetInstallStatus: Mock;

	function getInteractionSwitch(): HTMLElement {
		return screen.getByRole('switch', { name: 'Browser interaction for Claude Code' });
	}

	function getRadio(label: 'Risky only' | 'Every action' | 'JS only'): HTMLElement {
		return screen.getByRole('radio', { name: label });
	}

	beforeEach(() => {
		mockNotifyToast.mockClear();
		mockGetInstallStatus = vi.fn().mockResolvedValue([]);
		// The global setup's window.maestro mock has no coworking namespace, so
		// attach one per test (the component treats a missing bridge as "no agents").
		(window.maestro as unknown as Record<string, unknown>).coworking = {
			getInstallStatus: mockGetInstallStatus,
			install: vi.fn().mockResolvedValue(undefined),
			uninstall: vi.fn().mockResolvedValue(undefined),
			installAll: vi.fn().mockResolvedValue([]),
		};
		// Explicit baseline (singleton store persists across tests). Limit is a
		// deliberately non-default value so no test leans on shipped defaults.
		useSettingsStore.setState({
			coworkingBrowserInteraction: [],
			coworkingBrowserInteractionConfirm: {},
			coworkingBackgroundBrowsers: false,
			coworkingBackgroundBrowsersLimit: 3,
		});
	});

	afterEach(() => {
		delete (window.maestro as unknown as Record<string, unknown>).coworking;
	});

	it('fetches install status on mount and renders a row per agent with name and config path', async () => {
		mockGetInstallStatus.mockResolvedValue([installedClaude, uninstalledCodex]);
		render(<CoworkingSetup theme={mockTheme} />);

		expect(await screen.findByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('Codex')).toBeInTheDocument();
		expect(screen.getByText('/home/user/.claude.json')).toBeInTheDocument();
		expect(screen.getByText('/home/user/.codex/config.toml')).toBeInTheDocument();
		expect(mockGetInstallStatus).toHaveBeenCalledTimes(1);
	});

	it('shows Install and no interaction controls for an uninstalled agent', async () => {
		mockGetInstallStatus.mockResolvedValue([uninstalledCodex]);
		render(<CoworkingSetup theme={mockTheme} />);
		await screen.findByText('Codex');

		expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
		// The only switch on the page is the panel-level Background browsing
		// toggle - the uninstalled row must not grow an interaction switch.
		const switches = screen.getAllByRole('switch');
		expect(switches).toHaveLength(1);
		expect(switches[0]).toHaveAccessibleName('Background browsing');
		expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
	});

	it('shows Uninstall and an off interaction switch without radiogroup or warning for an installed agent', async () => {
		// A stored 'off' policy alone must not surface the warning: the
		// interaction sub-section only exists while interaction is enabled.
		useSettingsStore.setState({
			coworkingBrowserInteractionConfirm: { 'claude-code': 'off' },
		});
		mockGetInstallStatus.mockResolvedValue([installedClaude]);
		render(<CoworkingSetup theme={mockTheme} />);
		await screen.findByText('Claude Code');

		expect(screen.getByRole('button', { name: 'Uninstall' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
		expect(getInteractionSwitch()).toHaveAttribute('aria-checked', 'false');
		expect(
			screen.queryByRole('radiogroup', { name: 'Ask before actions' })
		).not.toBeInTheDocument();
		expect(screen.queryByText(WARNING_TEXT)).not.toBeInTheDocument();
	});

	it('clicking the interaction switch toggles agent membership in coworkingBrowserInteraction and flips aria-checked', async () => {
		// Pre-seed another agent to prove the toggle appends/removes rather than
		// overwriting the whole list.
		useSettingsStore.setState({ coworkingBrowserInteraction: ['codex'] });
		mockGetInstallStatus.mockResolvedValue([installedClaude]);
		render(<CoworkingSetup theme={mockTheme} />);
		await screen.findByText('Claude Code');

		const interactionSwitch = getInteractionSwitch();
		fireEvent.click(interactionSwitch);
		expect(useSettingsStore.getState().coworkingBrowserInteraction).toEqual(
			expect.arrayContaining(['codex', 'claude-code'])
		);
		expect(interactionSwitch).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('radiogroup', { name: 'Ask before actions' })).toBeInTheDocument();

		fireEvent.click(interactionSwitch);
		expect(useSettingsStore.getState().coworkingBrowserInteraction).toEqual(['codex']);
		expect(interactionSwitch).toHaveAttribute('aria-checked', 'false');
		expect(
			screen.queryByRole('radiogroup', { name: 'Ask before actions' })
		).not.toBeInTheDocument();
	});

	it('selects Risky only with the dangerous description when interaction is on and no policy is stored', async () => {
		useSettingsStore.setState({ coworkingBrowserInteraction: ['claude-code'] });
		mockGetInstallStatus.mockResolvedValue([installedClaude]);
		render(<CoworkingSetup theme={mockTheme} />);
		await screen.findByText('Claude Code');

		const group = screen.getByRole('radiogroup', { name: 'Ask before actions' });
		expect(within(group).getByRole('radio', { name: 'Risky only' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(within(group).getByRole('radio', { name: 'Every action' })).toHaveAttribute(
			'aria-checked',
			'false'
		);
		expect(within(group).getByRole('radio', { name: 'JS only' })).toHaveAttribute(
			'aria-checked',
			'false'
		);
		expect(screen.getByText(DANGEROUS_DESCRIPTION)).toBeInTheDocument();
		expect(screen.queryByText(WARNING_TEXT)).not.toBeInTheDocument();
	});

	it("writes policy 'off' on a single click of JS only, swaps the description, and shows the warning", async () => {
		// Another agent's stored policy must survive the write (merge, not replace).
		useSettingsStore.setState({
			coworkingBrowserInteraction: ['claude-code'],
			coworkingBrowserInteractionConfirm: { codex: 'all' },
		});
		mockGetInstallStatus.mockResolvedValue([installedClaude]);
		render(<CoworkingSetup theme={mockTheme} />);
		await screen.findByText('Claude Code');

		// One click straight from the 'dangerous' default to 'off' - a cycling
		// control would land elsewhere.
		fireEvent.click(getRadio('JS only'));

		const confirm = useSettingsStore.getState().coworkingBrowserInteractionConfirm;
		expect(confirm['claude-code']).toBe('off');
		expect(confirm['codex']).toBe('all');
		expect(getRadio('JS only')).toHaveAttribute('aria-checked', 'true');
		expect(getRadio('Risky only')).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByText(OFF_DESCRIPTION)).toBeInTheDocument();
		expect(screen.queryByText(DANGEROUS_DESCRIPTION)).not.toBeInTheDocument();
		expect(screen.getByText(WARNING_TEXT)).toBeInTheDocument();
	});

	it("writes policy 'all' on a single click of Every action from 'off' and removes the warning", async () => {
		useSettingsStore.setState({
			coworkingBrowserInteraction: ['claude-code'],
			coworkingBrowserInteractionConfirm: { 'claude-code': 'off' },
		});
		mockGetInstallStatus.mockResolvedValue([installedClaude]);
		render(<CoworkingSetup theme={mockTheme} />);
		await screen.findByText('Claude Code');

		expect(screen.getByText(WARNING_TEXT)).toBeInTheDocument();

		fireEvent.click(getRadio('Every action'));

		expect(useSettingsStore.getState().coworkingBrowserInteractionConfirm['claude-code']).toBe(
			'all'
		);
		expect(getRadio('Every action')).toHaveAttribute('aria-checked', 'true');
		expect(getRadio('JS only')).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByText(ALL_DESCRIPTION)).toBeInTheDocument();
		expect(screen.queryByText(WARNING_TEXT)).not.toBeInTheDocument();
	});

	it('toggles background browsing and shows the Limit input only while on', async () => {
		render(<CoworkingSetup theme={mockTheme} />);
		await waitFor(() => expect(mockGetInstallStatus).toHaveBeenCalled());

		const backgroundSwitch = screen.getByRole('switch', { name: 'Background browsing' });
		expect(backgroundSwitch).toHaveAttribute('aria-checked', 'false');
		expect(screen.queryByRole('spinbutton', { name: /Limit/ })).not.toBeInTheDocument();

		fireEvent.click(backgroundSwitch);
		expect(useSettingsStore.getState().coworkingBackgroundBrowsers).toBe(true);
		expect(backgroundSwitch).toHaveAttribute('aria-checked', 'true');

		const limitInput = screen.getByRole('spinbutton', { name: /Limit/ });
		fireEvent.change(limitInput, { target: { value: '5' } });
		expect(useSettingsStore.getState().coworkingBackgroundBrowsersLimit).toBe(5);

		fireEvent.click(backgroundSwitch);
		expect(useSettingsStore.getState().coworkingBackgroundBrowsers).toBe(false);
		expect(backgroundSwitch).toHaveAttribute('aria-checked', 'false');
		expect(screen.queryByRole('spinbutton', { name: /Limit/ })).not.toBeInTheDocument();
	});

	it('surfaces a red toast and renders zero agent rows when getInstallStatus rejects', async () => {
		mockGetInstallStatus.mockRejectedValue(new Error('config unreadable'));
		render(<CoworkingSetup theme={mockTheme} />);

		await waitFor(() =>
			expect(mockNotifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					color: 'red',
					title: 'Coworking',
					message: expect.stringContaining('config unreadable'),
				})
			)
		);
		// Panel survived the rejection: header still present, no agent rows.
		expect(screen.getByText('Coworking Setup')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
		expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
	});
});
