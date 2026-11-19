/**
 * ParameterSheet: one row per playbook parameter, the right control per type,
 * provenance badges, inline validation, the Run gate, and saving answers to
 * the playbook record.
 */

import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParameterSheet } from '../../../../renderer/components/PlaybookLaunch/ParameterSheet';
import { PLAYBOOK_PARAM_SAVE_DEBOUNCE_MS } from '../../../../renderer/hooks/batch/usePlaybookParamAnswers';
import type { Playbook } from '../../../../shared/types';
import { mockTheme } from '../../../helpers/mockTheme';

const PROMPT = [
	'<!-- CONFIGURE: The pull request to review -->',
	'**PR_URL:** `https://github.com/OWNER/REPO/pull/XXX`',
	'',
	'<!-- CONFIGURE: How many items to process -->',
	'**MAX_ITEMS:** `25`',
	'',
	'<!-- CONFIGURE (optional): Anything else the agent should know -->',
	'**NOTES:** ``',
].join('\n');

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'pb-1',
		name: 'Review a PR',
		createdAt: 0,
		updatedAt: 0,
		documents: [{ filename: 'review', resetOnCompletion: false }],
		loopEnabled: false,
		prompt: PROMPT,
		parameterOverlay: [
			{ name: 'PR_URL', type: 'url', required: true },
			{ name: 'MAX_ITEMS', type: 'number', min: 1, max: 100 },
			{ name: 'CHECKS', type: 'multi-enum', required: false, options: ['lint', 'types', 'tests'] },
		],
		...overrides,
	};
}

const update = () => window.maestro.playbooks.update as ReturnType<typeof vi.fn>;

function input(name: string): HTMLInputElement {
	return screen.getByTestId(`parameter-row-${name}-input`).querySelector('input')!;
}

function provenance(name: string): string {
	return screen.getByTestId(`parameter-row-${name}-provenance`).textContent ?? '';
}

function renderSheet(props: Partial<ComponentProps<typeof ParameterSheet>> = {}) {
	render(
		<ParameterSheet
			theme={mockTheme}
			sessionId="agent-1"
			playbook={makePlaybook()}
			onRun={vi.fn()}
			{...props}
		/>
	);
}

describe('ParameterSheet', () => {
	beforeEach(() => {
		update().mockClear();
		update().mockResolvedValue({ success: true, playbook: {} });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('rendering per type', () => {
		it('renders one row per parameter with a type badge and required marker', () => {
			renderSheet();
			for (const name of ['PR_URL', 'MAX_ITEMS', 'NOTES', 'CHECKS']) {
				expect(screen.getByTestId(`parameter-row-${name}`)).toBeInTheDocument();
			}
			const prRow = screen.getByTestId('parameter-row-PR_URL');
			expect(prRow).toHaveTextContent('URL');
			expect(prRow.querySelector('[aria-label="required"]')).not.toBeNull();
			expect(screen.getByTestId('parameter-row-NOTES')).toHaveTextContent('Text');
			expect(
				screen.getByTestId('parameter-row-NOTES').querySelector('[aria-label="required"]')
			).toBeNull();
			expect(screen.getByText('The pull request to review')).toBeInTheDocument();
		});

		it('uses a url input, and a number input carrying min and max', () => {
			renderSheet();
			expect(input('PR_URL').type).toBe('url');
			const max = input('MAX_ITEMS');
			expect(max.type).toBe('number');
			expect(max.min).toBe('1');
			expect(max.max).toBe('100');
			expect(max.placeholder).toBe('25');
		});

		it('draws a multi-enum as chips and saves the selection as a comma list', () => {
			vi.useFakeTimers();
			renderSheet();
			fireEvent.click(screen.getByTestId('parameter-row-CHECKS-chips-tests'));
			fireEvent.click(screen.getByTestId('parameter-row-CHECKS-chips-lint'));
			expect(screen.getByTestId('parameter-row-CHECKS-chips-lint')).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			act(() => vi.advanceTimersByTime(PLAYBOOK_PARAM_SAVE_DEBOUNCE_MS));
			expect(update()).toHaveBeenLastCalledWith('agent-1', 'pb-1', {
				parameterValues: { CHECKS: 'lint, tests' },
			});
		});

		it('says so when the playbook has no parameters', () => {
			renderSheet({ playbook: makePlaybook({ prompt: 'Do the work.', parameterOverlay: [] }) });
			expect(screen.getByText('This playbook has no parameters to answer.')).toBeInTheDocument();
			expect(screen.getByTestId('parameter-sheet-run')).not.toBeDisabled();
		});
	});

	describe('provenance', () => {
		it('badges Default, Unresolved, Detected, and You', () => {
			renderSheet({
				playbook: makePlaybook({ parameterValues: { NOTES: 'be brief' } }),
				proposals: { PR_URL: { value: 'https://github.com/a/b/pull/7', evidence: 'Open PR' } },
			});
			expect(provenance('MAX_ITEMS')).toBe('Default');
			expect(provenance('CHECKS')).toBe('Unresolved');
			expect(provenance('PR_URL')).toBe('Detected');
			expect(screen.getByTestId('parameter-row-PR_URL-provenance')).toHaveAttribute(
				'title',
				'Open PR'
			);
			expect(input('PR_URL').value).toBe('https://github.com/a/b/pull/7');
			expect(provenance('NOTES')).toBe('You');
		});

		it("turns a detected value into the user's once edited", () => {
			renderSheet({ proposals: { PR_URL: { value: 'https://github.com/a/b/pull/7' } } });
			fireEvent.change(input('PR_URL'), { target: { value: 'https://github.com/a/b/pull/8' } });
			expect(provenance('PR_URL')).toBe('You');
		});
	});

	describe('validation and the Run gate', () => {
		it('disables Run while a required parameter is unresolved', () => {
			renderSheet();
			const run = screen.getByTestId('parameter-sheet-run');
			expect(run).toBeDisabled();
			expect(screen.getByTestId('parameter-sheet-blocked')).toHaveTextContent(
				'Missing required parameters: PR_URL'
			);
			// The required error waits for a touch.
			expect(screen.queryByText('PR_URL is required.')).toBeNull();
		});

		it('shows inline errors and keeps Run disabled while any value is invalid', () => {
			renderSheet();
			fireEvent.change(input('PR_URL'), { target: { value: 'not a url' } });
			expect(
				screen.getByText('PR_URL must be a URL, such as https://example.com.')
			).toBeInTheDocument();
			expect(screen.getByTestId('parameter-sheet-run')).toBeDisabled();

			fireEvent.change(input('PR_URL'), { target: { value: 'https://github.com/a/b/pull/1' } });
			expect(screen.getByTestId('parameter-sheet-run')).not.toBeDisabled();

			fireEvent.change(input('MAX_ITEMS'), { target: { value: '500' } });
			expect(screen.getByText('MAX_ITEMS must be at most 100.')).toBeInTheDocument();
			expect(screen.getByTestId('parameter-sheet-run')).toBeDisabled();
		});

		it('shows the required error once the user clears a required field', () => {
			renderSheet();
			fireEvent.change(input('PR_URL'), { target: { value: 'x' } });
			fireEvent.change(input('PR_URL'), { target: { value: '' } });
			expect(screen.getByText('PR_URL is required.')).toBeInTheDocument();
		});

		it('rejects a multi-enum token the options do not allow', () => {
			renderSheet({
				playbook: makePlaybook({
					parameterValues: { PR_URL: 'https://github.com/a/b/pull/1', CHECKS: 'lint, fuzz' },
				}),
			});
			expect(screen.getByText(/CHECKS does not allow "fuzz"/)).toBeInTheDocument();
			expect(screen.getByTestId('parameter-sheet-run')).toBeDisabled();
		});
	});

	describe('persistence', () => {
		it('saves answers through playbooks:update once typing settles, dropping blanks', () => {
			vi.useFakeTimers();
			renderSheet({ playbook: makePlaybook({ parameterValues: { NOTES: 'old' } }) });
			fireEvent.change(input('PR_URL'), { target: { value: 'https://github.com/a/b/pull/1' } });
			fireEvent.change(input('NOTES'), { target: { value: '' } });
			expect(update()).not.toHaveBeenCalled();

			act(() => vi.advanceTimersByTime(PLAYBOOK_PARAM_SAVE_DEBOUNCE_MS));
			expect(update()).toHaveBeenCalledTimes(1);
			expect(update()).toHaveBeenCalledWith('agent-1', 'pb-1', {
				parameterValues: { PR_URL: 'https://github.com/a/b/pull/1' },
			});
		});

		it('writes a pending save before Run, then runs with answers plus proposals', async () => {
			const onRun = vi.fn();
			renderSheet({
				onRun,
				proposals: { PR_URL: { value: 'https://github.com/a/b/pull/7' } },
			});
			fireEvent.change(input('MAX_ITEMS'), { target: { value: '5' } });
			fireEvent.click(screen.getByTestId('parameter-sheet-run'));

			await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
			expect(update()).toHaveBeenCalledWith('agent-1', 'pb-1', {
				parameterValues: { MAX_ITEMS: '5' },
			});
			expect(update().mock.invocationCallOrder[0]).toBeLessThan(onRun.mock.invocationCallOrder[0]);
			expect(onRun).toHaveBeenCalledWith({
				MAX_ITEMS: '5',
				PR_URL: 'https://github.com/a/b/pull/7',
			});
		});

		it('uses the given label and icon for the primary button', () => {
			renderSheet({ runLabel: 'Done', runIcon: <span data-testid="done-icon" /> });
			expect(screen.getByTestId('parameter-sheet-run')).toHaveTextContent('Done');
			expect(screen.getByTestId('done-icon')).toBeInTheDocument();
		});
	});
});
