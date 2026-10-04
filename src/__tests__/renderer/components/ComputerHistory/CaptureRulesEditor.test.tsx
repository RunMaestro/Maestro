import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CaptureRulesEditor,
	buildAppRows,
	isAppRecorded,
} from '../../../../renderer/components/ComputerHistory/CaptureRulesEditor';
import { defaultComputerHistoryConfig } from '../../../../shared/computer-history/config';
import type { CaptureRule, ComputerHistoryConfig } from '../../../../shared/computer-history/types';
import { mockTheme } from '../../../helpers/mockTheme';

const slack = {
	id: 'com.tinyspeck.slackmacgap',
	name: 'Slack',
	events: 10,
	activeMs: 120_000,
	lastWindowMs: 0,
};
const notes = { id: 'com.apple.Notes', name: 'Notes', events: 0, activeMs: 0, lastWindowMs: 0 };

function rule(
	action: CaptureRule['action'],
	value: string,
	id = `${action}-${value}`
): CaptureRule {
	return { id, match: 'app', value, action };
}

describe('buildAppRows / isAppRecorded', () => {
	it('attaches matching rules (id or name) and keeps rules for apps not seen lately', () => {
		const rows = buildAppRows(
			[slack, notes],
			[
				rule('ignore', 'slack'),
				rule('record', 'com.apple.notes'),
				rule('record', 'us.zoom.xos'),
				{ id: 'd', match: 'domain', value: 'bank.example.com', action: 'ignore' },
			]
		);
		expect(rows.map((r) => r.id)).toEqual([
			'com.tinyspeck.slackmacgap',
			'com.apple.Notes',
			'us.zoom.xos',
		]);
		expect(rows[0].ignoreRules).toHaveLength(1);
		expect(rows[1].recordRules).toHaveLength(1);
		expect(rows[2].activity).toBeNull();
	});

	it('one switch, two meanings', () => {
		const none = { ignoreRules: [], recordRules: [] };
		const ignored = { ignoreRules: [1], recordRules: [] };
		const listed = { ignoreRules: [], recordRules: [1] };
		const both = { ignoreRules: [1], recordRules: [1] };
		expect(isAppRecorded('exclude', none)).toBe(true);
		expect(isAppRecorded('exclude', ignored)).toBe(false);
		expect(isAppRecorded('include', none)).toBe(false);
		expect(isAppRecorded('include', listed)).toBe(true);
		expect(isAppRecorded('include', both)).toBe(false);
	});
});

describe('CaptureRulesEditor', () => {
	let config: ComputerHistoryConfig;
	let original: unknown;
	let api: Record<string, ReturnType<typeof vi.fn>>;

	beforeEach(() => {
		original = (window.maestro as unknown as Record<string, unknown>).computerHistory;
		config = defaultComputerHistoryConfig();
		api = {
			getConfig: vi.fn(async () => config),
			setConfig: vi.fn(async (patch: Partial<ComputerHistoryConfig>) => {
				config = { ...config, ...patch };
				return config;
			}),
			knownApps: vi.fn(async () => [slack, notes]),
			listRules: vi.fn(async () => ({ rules: config.rules, builtIn: ['com.maestro.app'] })),
			addRule: vi.fn(async (match: 'app' | 'domain', value: string, action = 'ignore') => {
				const r = {
					id: `${action}-${value}`,
					match,
					value: value.toLowerCase(),
					action,
				} as CaptureRule;
				config = { ...config, rules: [...config.rules, r] };
				return { rule: r, matches: [{ id: value }] };
			}),
			removeRule: vi.fn(async (id: string) => {
				const r = config.rules.find((x) => x.id === id) ?? null;
				config = { ...config, rules: config.rules.filter((x) => x.id !== id) };
				return r;
			}),
		};
		(window.maestro as unknown as Record<string, unknown>).computerHistory = api;
	});
	afterEach(() => {
		(window.maestro as unknown as Record<string, unknown>).computerHistory = original;
	});

	it('exclude mode: switching an app off writes an ignore rule, on removes it', async () => {
		const onConfigChange = vi.fn();
		render(<CaptureRulesEditor theme={mockTheme} onConfigChange={onConfigChange} />);
		const row = await screen.findByTestId('computer-history-app-com.tinyspeck.slackmacgap');
		fireEvent.click(within(row).getByRole('switch'));
		await waitFor(() =>
			expect(api.addRule).toHaveBeenCalledWith('app', 'com.tinyspeck.slackmacgap', 'ignore')
		);
		await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
		fireEvent.click(
			within(await screen.findByTestId('computer-history-app-com.tinyspeck.slackmacgap')).getByRole(
				'switch'
			)
		);
		await waitFor(() =>
			expect(api.removeRule).toHaveBeenCalledWith('ignore-com.tinyspeck.slackmacgap')
		);
	});

	it('include mode: warns while the list is empty and switching an app on adds a record rule', async () => {
		config = { ...config, appMode: 'include' };
		render(<CaptureRulesEditor theme={mockTheme} />);
		expect(await screen.findByTestId('computer-history-include-empty')).toBeTruthy();
		const row = await screen.findByTestId('computer-history-app-com.apple.Notes');
		expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('false');
		fireEvent.click(within(row).getByRole('switch'));
		await waitFor(() =>
			expect(api.addRule).toHaveBeenCalledWith('app', 'com.apple.Notes', 'record')
		);
		await waitFor(() => expect(screen.queryByTestId('computer-history-include-empty')).toBeNull());
	});

	it('switches the app mode through setConfig', async () => {
		render(<CaptureRulesEditor theme={mockTheme} />);
		fireEvent.click(await screen.findByText('Only these apps'));
		await waitFor(() => expect(api.setConfig).toHaveBeenCalledWith({ appMode: 'include' }));
	});

	it('adds a domain exclusion', async () => {
		render(<CaptureRulesEditor theme={mockTheme} />);
		const input = await screen.findByPlaceholderText('bank.example.com');
		fireEvent.change(input, { target: { value: 'bank.example.com' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() =>
			expect(api.addRule).toHaveBeenCalledWith('domain', 'bank.example.com', 'ignore')
		);
	});
});
