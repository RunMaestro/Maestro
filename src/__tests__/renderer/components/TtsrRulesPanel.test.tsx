/**
 * Tests for the Right Bar Rules tab.
 *
 * The behaviour that matters is scoping: the panel acts on the project root of
 * the agent the user is looking at, and its settings writes go to that
 * project's `.maestro/ttsr.yaml` rather than to a global store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TtsrRulesPanel } from '../../../renderer/components/TtsrRulesPanel';
import { createMockTheme } from '../../helpers/mockTheme';
import type { TtsrRule, TtsrRuleListResult } from '../../../shared/ttsr-types';

const theme = createMockTheme();
const PROJECT = '/repo';

function makeRule(overrides: Partial<TtsrRule> = {}): TtsrRule {
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

beforeEach(() => {
	vi.clearAllMocks();
	window.maestro.ttsr.listRules = vi.fn().mockResolvedValue(listResult());
	window.maestro.ttsr.writeProjectSettings = vi.fn().mockResolvedValue({ path: 'x' });
	window.maestro.ttsr.deleteRule = vi.fn().mockResolvedValue({ deleted: true });
	window.maestro.prompts.get = vi
		.fn()
		.mockResolvedValue({ success: true, content: 'Brief. {{USER_REQUEST}}' });
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

	it('degrades when the preload has no rule API', () => {
		const original = window.maestro.ttsr;
		// @ts-expect-error - simulating an older preload
		window.maestro.ttsr = { onTriggered: vi.fn() };

		render(<TtsrRulesPanel theme={theme} projectRoot={PROJECT} />);

		expect(screen.getByText(/not available in this build/i)).toBeInTheDocument();
		window.maestro.ttsr = original;
	});
});
