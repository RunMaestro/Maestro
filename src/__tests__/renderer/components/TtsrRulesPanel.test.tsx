/**
 * Tests for the Right Bar Rules tab.
 *
 * The behaviour that matters is scoping: the panel acts on the project root of
 * the agent the user is looking at, and its settings writes go to that
 * project's `.maestro/ttsr.yaml` rather than to a global store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockNotifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));
import { TtsrRulesPanel } from '../../../renderer/components/TtsrRulesPanel';
import { createMockTheme } from '../../helpers/mockTheme';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { TtsrRuleListEntry, TtsrRuleListResult } from '../../../shared/ttsr-types';

const theme = createMockTheme();
const PROJECT = '/repo';

function makeRule(overrides: Partial<TtsrRuleListEntry> = {}): TtsrRuleListEntry {
	return {
		name: 'no-force-push',
		description: 'Stop force-pushes to shared branches',
		condition: ['git push .*--force'],
		astCondition: [],
		scope: ['tool:bash'],
		globs: [],
		interruptMode: 'always',
		repeatMode: 'after-gap',
		repeatGap: 3,
		agents: ['claude-code'],
		content: 'Do not force-push.',
		path: '.maestro/rules/no-force-push.md',
		disabled: false,
		...overrides,
	};
}

function listResult(overrides: Partial<TtsrRuleListResult> = {}): TtsrRuleListResult {
	return {
		rules: [],
		settings: { enabled: true, disabledRules: [] },
		warnings: [],
		errors: [],
		configExists: true,
		...overrides,
	};
}

/** Callback the panel handed to `ttsr:rulesChanged`, so a test can fire it. */
let rulesChangedCb: ((payload: { projectRoot?: string }) => void) | undefined;
const offRulesChanged = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	rulesChangedCb = undefined;
	window.maestro.ttsr.onRulesChanged = vi.fn((cb) => {
		rulesChangedCb = cb;
		return offRulesChanged;
	});
	window.maestro.ttsr.listRules = vi.fn().mockResolvedValue(listResult());
	window.maestro.ttsr.writeProjectSettings = vi.fn().mockResolvedValue({ path: 'x' });
	window.maestro.ttsr.deleteRule = vi.fn().mockResolvedValue({ deleted: true });
	window.maestro.prompts.get = vi
		.fn()
		.mockResolvedValue({ success: true, content: 'Brief. {{USER_REQUEST}}' });
	useSettingsStore.setState({ ttsrDisabledRules: [] });
});

describe('TtsrRulesPanel', () => {
	it('loads rules for the active agent’s project root', async () => {
		window.maestro.ttsr.listRules = vi.fn().mockResolvedValue(listResult({ rules: [makeRule()] }));

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);

		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalledWith(PROJECT));
		expect(await screen.findByText('no-force-push')).toBeInTheDocument();
		expect(screen.getByText('tool:bash · always')).toBeInTheDocument();
	});

	it('prompts to pick an agent when none is active', () => {
		render(<TtsrRulesPanel theme={theme} projectRoot={null} />);

		expect(screen.getByText(/select an agent/i)).toBeInTheDocument();
		expect(window.maestro.ttsr.listRules).not.toHaveBeenCalled();
	});

	it('writes the project toggle to that project, not to global settings', async () => {
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalled());

		fireEvent.click(screen.getByRole('checkbox'));

		expect(window.maestro.ttsr.writeProjectSettings).toHaveBeenCalledWith(PROJECT, {
			enabled: false,
		});
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('clears contextMode back to the global default when set to empty', async () => {
		window.maestro.ttsr.listRules = vi
			.fn()
			.mockResolvedValue(
				listResult({ settings: { enabled: true, disabledRules: [], contextMode: 'discard' } })
			);

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalled());

		fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });

		// Undefined, not 'keep': the project stops stating an opinion so the global
		// setting applies again.
		expect(window.maestro.ttsr.writeProjectSettings).toHaveBeenCalledWith(PROJECT, {
			contextMode: undefined,
		});
	});

	it('hands rule authoring to the agent with the request folded in', async () => {
		const onSendToAgent = vi.fn();
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} onSendToAgent={onSendToAgent} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalled());

		fireEvent.change(screen.getByPlaceholderText(/force-push/i), {
			target: { value: 'no console.log' },
		});
		fireEvent.click(screen.getByRole('button', { name: /write this rule/i }));

		await waitFor(() => expect(onSendToAgent).toHaveBeenCalledTimes(1));
		expect(onSendToAgent.mock.calls[0][0]).toContain('no console.log');
	});

	it('shows load warnings, which are the only signal an inert rule gives', async () => {
		window.maestro.ttsr.listRules = vi
			.fn()
			.mockResolvedValue(listResult({ warnings: ['no-force-push.md: invalid regex "(" dropped'] }));

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);

		expect(await screen.findByText(/invalid regex/)).toBeInTheDocument();
	});

	it('reports an empty project instead of looking broken', async () => {
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);

		expect(await screen.findByText(/no rules in this project yet/i)).toBeInTheDocument();
	});

	// Authoring is delegated to the agent, so the rule appears when the agent
	// writes the file. Without this push the loop ends on a stale list.
	it('re-lists when main says the project’s rules changed', async () => {
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalledTimes(1));

		window.maestro.ttsr.listRules = vi.fn().mockResolvedValue(listResult({ rules: [makeRule()] }));
		rulesChangedCb?.({ projectRoot: PROJECT });

		expect(await screen.findByText('no-force-push')).toBeInTheDocument();
	});

	it('ignores changes to a different project', async () => {
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalledTimes(1));

		rulesChangedCb?.({ projectRoot: '/some/other/repo' });
		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(window.maestro.ttsr.listRules).toHaveBeenCalledTimes(1);
	});

	it('coalesces a burst of watcher events into one re-list', async () => {
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalledTimes(1));

		rulesChangedCb?.({ projectRoot: PROJECT });
		rulesChangedCb?.({ projectRoot: PROJECT });
		rulesChangedCb?.({ projectRoot: PROJECT });

		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalledTimes(2));
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(window.maestro.ttsr.listRules).toHaveBeenCalledTimes(2);
	});

	it('unsubscribes on unmount', async () => {
		const { unmount } = render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.onRulesChanged).toHaveBeenCalled());

		unmount();

		expect(offRulesChanged).toHaveBeenCalledTimes(1);
	});

	// A disabled rule used to vanish from the list, so the only way back was
	// hand-editing ttsr.yaml.
	it('shows a project-disabled rule and re-enables it from the panel', async () => {
		window.maestro.ttsr.listRules = vi.fn().mockResolvedValue(
			listResult({
				rules: [makeRule({ disabled: true }), makeRule({ name: 'other', path: 'b.md' })],
				settings: { enabled: true, disabledRules: ['no-force-push'] },
			})
		);

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		expect(await screen.findByText('no-force-push')).toBeInTheDocument();
		expect(screen.getByText(/tool:bash · always · disabled/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Enable no-force-push' }));

		await waitFor(() =>
			expect(window.maestro.ttsr.writeProjectSettings).toHaveBeenCalledWith(PROJECT, {
				disabledRules: [],
			})
		);
	});

	it('disables an enabled rule through the project file', async () => {
		window.maestro.ttsr.listRules = vi
			.fn()
			.mockResolvedValue(
				listResult({ rules: [makeRule()], settings: { enabled: true, disabledRules: [] } })
			);

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await screen.findByText('no-force-push');

		fireEvent.click(screen.getByRole('button', { name: 'Disable no-force-push' }));

		await waitFor(() =>
			expect(window.maestro.ttsr.writeProjectSettings).toHaveBeenCalledWith(PROJECT, {
				disabledRules: ['no-force-push'],
			})
		);
	});

	// A rule can also be held down by the machine-wide setting, which the project
	// file knows nothing about.
	it('re-enables a globally disabled rule through the setting', async () => {
		useSettingsStore.setState({ ttsrDisabledRules: ['no-force-push'] });
		window.maestro.ttsr.listRules = vi.fn().mockResolvedValue(listResult({ rules: [makeRule()] }));

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await screen.findByText('no-force-push');

		fireEvent.click(screen.getByRole('button', { name: 'Enable no-force-push' }));

		await waitFor(() => expect(useSettingsStore.getState().ttsrDisabledRules).toEqual([]));
		// The project file said nothing about this rule, so it is left alone.
		expect(window.maestro.ttsr.writeProjectSettings).not.toHaveBeenCalled();
	});

	it('requires a second click to delete a rule', async () => {
		window.maestro.ttsr.listRules = vi.fn().mockResolvedValue(listResult({ rules: [makeRule()] }));

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await screen.findByText('no-force-push');

		fireEvent.click(screen.getByRole('button', { name: 'Delete no-force-push' }));
		expect(window.maestro.ttsr.deleteRule).not.toHaveBeenCalled();

		fireEvent.click(await screen.findByRole('button', { name: 'Confirm delete no-force-push' }));

		await waitFor(() =>
			expect(window.maestro.ttsr.deleteRule).toHaveBeenCalledWith(PROJECT, makeRule().path)
		);
	});

	it('reports a failed listing instead of showing an empty project', async () => {
		window.maestro.ttsr.listRules = vi.fn().mockRejectedValue(new Error('EACCES'));

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);

		await waitFor(() =>
			expect(mockNotifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }))
		);
	});

	it('reports a failed settings write', async () => {
		window.maestro.ttsr.writeProjectSettings = vi.fn().mockRejectedValue(new Error('read-only fs'));
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalled());

		fireEvent.click(screen.getByRole('checkbox'));

		await waitFor(() =>
			expect(mockNotifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					color: 'red',
					message: expect.stringContaining('project settings'),
				})
			)
		);
	});

	// App.tsx toasts when there is no agent input to send to; the panel's half of
	// that contract is not offering the hand-off at all without a handler.
	it('hides the authoring hand-off when no agent can receive it', async () => {
		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);
		await waitFor(() => expect(window.maestro.ttsr.listRules).toHaveBeenCalled());

		expect(screen.queryByRole('button', { name: /write this rule/i })).not.toBeInTheDocument();
		expect(screen.queryByPlaceholderText(/force-push/i)).not.toBeInTheDocument();
	});

	it('degrades when the preload has no rule API', () => {
		const original = window.maestro.ttsr;
		// @ts-expect-error - simulating an older preload
		window.maestro.ttsr = { onTriggered: vi.fn() };

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);

		expect(screen.getByText(/not available in this build/i)).toBeInTheDocument();
		window.maestro.ttsr = original;
	});
});
