/**
 * Tests for the decision ledger in Models > System One: the rows and what each
 * one says, the two pickers that narrow them, the Keep inputs toggle, and the
 * detail a row opens to (a kept input included, and never one that was not
 * kept).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { Theme } from '../../../../../renderer/types';
import {
	SystemOneLedgerSection,
	formatLedgerInput,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/SystemOneLedgerSection';
import type { SystemOneHookState } from '../../../../../renderer/hooks/localModels';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import type {
	SystemOneLedgerEntry,
	SystemOneLedgerPage,
} from '../../../../../shared/local-models/system-one-ledger';
import { formatSystemOneLedgerInput } from '../../../../../shared/local-models/system-one-ledger';
import { noul } from '../../../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_ENGINE_DISCLOSURES,
	SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS,
	type SystemOneReport,
} from '../../../../../shared/local-models/system-one-settings';
import {
	LOCAL_MODEL_TASKS,
	LOCAL_MODEL_TASK_IDS,
	taskAcceptsSystemOne,
} from '../../../../../shared/local-models/tasks';
import { createMockSession } from '../../../../helpers/mockSession';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#a78bfa33',
		accentForeground: '#ffffff',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

const NOW = Date.now();

const ANSWERED: SystemOneLedgerEntry = {
	id: 'decision-2',
	taskId: 'cue-gate',
	engine: 'jev-cloud',
	model: 'jev-1.13.0',
	questionIds: ['proceed'],
	answers: { proceed: { type: 'noul', probability: 0.93 } },
	outcome: 'ok',
	startedAt: NOW - 60_000,
	latencyMs: 241,
	usage: { inputTokens: 412, outputTokens: 3 },
	costUsd: 0.0000173,
	agentId: 'agent-1',
};

const TIMED_OUT: SystemOneLedgerEntry = {
	id: 'decision-1',
	taskId: 'cue-gate',
	engine: 'local-judge',
	questionIds: ['proceed'],
	outcome: 'failed-closed',
	code: 'timeout',
	startedAt: NOW - 120_000,
	latencyMs: 30_000,
};

function page(overrides: Partial<SystemOneLedgerPage> = {}): SystemOneLedgerPage {
	return {
		entries: [ANSWERED, TIMED_OUT],
		total: 2,
		retentionDays: 30,
		notice: null,
		...overrides,
	};
}

function report(keepInputs: boolean): SystemOneReport {
	return {
		settings: {
			engine: 'jev-cloud',
			openJevUrl: null,
			timeoutMs: 1500,
			models: {},
			failPolicies: {},
			keepInputs,
		},
		engineLabel: 'Jev (TypeSafe cloud)',
		disclosure: SYSTEM_ONE_ENGINE_DISCLOSURES['jev-cloud'],
		baseUrl: 'https://api.typesafe.ai',
		model: null,
		modelLabel: null,
		timeoutMs: 1500,
		calibrated: true,
		keys: { 'jev-cloud': { source: 'none' }, openjev: { source: 'none' } },
		problem: null,
		failPolicies: [],
	};
}

function hook(overrides: Partial<SystemOneHookState> = {}): SystemOneHookState {
	return {
		report: report(false),
		busy: null,
		error: null,
		test: null,
		refresh: vi.fn().mockResolvedValue(undefined),
		set: vi.fn().mockResolvedValue(true),
		setKey: vi.fn().mockResolvedValue(true),
		clearKey: vi.fn().mockResolvedValue(true),
		runTest: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

const ledger = () =>
	window.maestro.localModels.systemOne.ledger as unknown as ReturnType<typeof vi.fn>;

async function renderSection(systemOne: SystemOneHookState = hook()) {
	const view = render(<SystemOneLedgerSection theme={theme} systemOne={systemOne} />);
	await waitFor(() => expect(ledger()).toHaveBeenCalled());
	return view;
}

describe('SystemOneLedgerSection', () => {
	beforeEach(() => {
		ledger().mockReset();
		ledger().mockResolvedValue(page());
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'agent-1', name: 'Triage bot' })],
		});
	});

	it('is the surface a settings search lands on, and is not selectable chrome', async () => {
		const { container } = await renderSection();

		const section = container.querySelector('[data-setting-id="local-models-system-one-ledger"]');
		expect(section).not.toBeNull();
		expect(section).toHaveClass('select-none');
		expect(screen.getByText('Decision ledger')).toBeInTheDocument();
	});

	it('lists each decision with its task, engine, outcome, answer and latency', async () => {
		await renderSection();

		const rows = await screen.findAllByTestId('system-one-ledger-row');
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveAttribute('data-outcome', 'ok');
		expect(rows[0]).toHaveTextContent('Cue gate');
		expect(rows[0]).toHaveTextContent('Jev (TypeSafe cloud)');
		expect(rows[0]).toHaveTextContent('Answered');
		expect(rows[0]).toHaveTextContent('yes (0.93)');
		expect(rows[0]).toHaveTextContent('241 ms');
		// The local judge is never shown as Jev, and a timeout says which way it failed.
		expect(rows[1]).toHaveTextContent('Local judge, not calibrated');
		expect(rows[1]).toHaveTextContent('Failed closed');
		expect(rows[1]).toHaveTextContent('timeout');
	});

	it('shows the agent, model, tokens and precise cost before expanding, without exposing the input', async () => {
		ledger().mockResolvedValue(
			page({ entries: [{ ...ANSWERED, input: 'Saved input stays inside the details.' }], total: 1 })
		);
		await renderSection();
		const row = await screen.findByTestId('system-one-ledger-row');
		const summary = within(row).getByTestId('system-one-ledger-summary');

		expect(summary).toHaveTextContent('Agent: Triage bot');
		expect(summary).toHaveTextContent('Model: jev-1.13.0');
		expect(summary).toHaveTextContent('Tokens: 412 in, 3 out');
		expect(summary).toHaveTextContent('Cost (est.): $0.000017');
		expect(summary).not.toHaveTextContent('Cached');
		expect(row).not.toHaveTextContent('Saved input stays inside the details.');
		expect(within(row).queryByTestId('system-one-ledger-detail')).toBeNull();
	});

	it('shows the decision topic and a question preview for agent requests before expansion', async () => {
		const emailQuestion = 'Is this email something the recipient personally needs to see?';
		ledger().mockResolvedValue(
			page({
				entries: [
					{
						...ANSWERED,
						taskId: 'agent:ask',
						input: formatSystemOneLedgerInput({
							state: 'PRIVATE EMAIL BODY',
							questions: { keep: noul(emailQuestion) },
						}),
					},
					{
						...TIMED_OUT,
						taskId: 'agent:ask',
						input: formatSystemOneLedgerInput({
							state: 'PRIVATE MESSAGE',
							questions: { tab: noul('Which working session is this message about?') },
						}),
					},
				],
			})
		);
		await renderSection();
		const rows = await screen.findAllByTestId('system-one-ledger-row');
		expect(within(rows[0]).getByTestId('system-one-ledger-topic')).toHaveTextContent(
			'Email classification'
		);
		expect(within(rows[0]).getByTestId('system-one-ledger-question')).toHaveTextContent(
			emailQuestion
		);
		expect(within(rows[0]).getByTestId('system-one-ledger-summary')).toHaveTextContent(
			'Agent: ask'
		);
		expect(rows[0]).not.toHaveTextContent('PRIVATE EMAIL BODY');
		expect(within(rows[0]).queryByTestId('system-one-ledger-detail')).toBeNull();
		expect(within(rows[1]).getByTestId('system-one-ledger-topic')).toHaveTextContent(
			'Session routing'
		);
		expect(rows[1]).not.toHaveTextContent('PRIVATE MESSAGE');
	});

	it('shows an unknown question verbatim with a bounded preview and full tooltip', async () => {
		const question = 'Should this document receive a review? ' + 'Additional criteria. '.repeat(20);
		ledger().mockResolvedValue(
			page({
				entries: [
					{
						...ANSWERED,
						taskId: 'agent:ask',
						input: formatSystemOneLedgerInput({
							state: 'private',
							questions: { review: noul(question) },
						}),
					},
				],
				total: 1,
			})
		);
		await renderSection();
		const preview = await screen.findByTestId('system-one-ledger-question');
		expect(preview).toHaveTextContent('Should this document receive a review?');
		expect(preview.textContent!.length).toBeLessThanOrEqual(160);
		expect(preview).toHaveAttribute('title', question.trim());
	});

	it('says when context is unavailable instead of guessing the subject', async () => {
		ledger().mockResolvedValue(page({ entries: [{ ...ANSWERED, taskId: 'agent:ask' }], total: 1 }));
		await renderSection();
		expect(await screen.findByTestId('system-one-ledger-topic')).toHaveTextContent(
			'Agent judgment'
		);
		expect(screen.getByTestId('system-one-ledger-question')).toHaveTextContent(
			'Decision context unavailable: input was not kept.'
		);
	});

	it('labels cached and unnamed runs, omitting metadata the record does not have', async () => {
		ledger().mockResolvedValue(
			page({
				entries: [
					{
						...ANSWERED,
						id: 'cached',
						agentId: undefined,
						model: undefined,
						usage: undefined,
						costUsd: undefined,
						cached: true,
					},
					{ ...TIMED_OUT, agentId: 'gone-1234567', costUsd: 0 },
				],
			})
		);
		await renderSection();
		const rows = await screen.findAllByTestId('system-one-ledger-row');
		const summary = within(rows[0]).getByTestId('system-one-ledger-summary');

		expect(summary).toHaveTextContent('Agent: No agent named');
		expect(summary).toHaveTextContent('Cached');
		expect(summary).not.toHaveTextContent('Model:');
		expect(summary).not.toHaveTextContent('Tokens:');
		expect(summary).not.toHaveTextContent('Cost (est.):');
		const removed = within(rows[1]).getByTestId('system-one-ledger-summary');
		expect(removed).toHaveTextContent('Agent: Removed agent gone-123');
		expect(removed).toHaveTextContent('Cost (est.): $0.00');
	});

	it('opens a row to its model, questions, tokens, cost and agent, and says the input was not kept', async () => {
		await renderSection();
		const [row, otherRow] = await screen.findAllByTestId('system-one-ledger-row');
		const button = within(row).getByRole('button');
		const chevron = within(row).getByTestId('system-one-ledger-chevron');
		expect(button).toHaveAttribute('aria-expanded', 'false');
		expect(button).toHaveAttribute('title', 'Expand decision details');
		expect(chevron).toHaveAttribute('aria-hidden', 'true');
		expect(chevron).not.toHaveClass('rotate-90');
		expect(within(row).queryByTestId('system-one-ledger-detail')).toBeNull();

		fireEvent.click(chevron);

		const detail = within(row).getByTestId('system-one-ledger-detail');
		expect(button).toHaveAttribute('aria-expanded', 'true');
		expect(button).toHaveAttribute('title', 'Collapse decision details');
		expect(button).toHaveAttribute('aria-controls', detail.id);
		expect(chevron).toHaveClass('rotate-90');
		expect(within(otherRow).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
		expect(within(otherRow).queryByTestId('system-one-ledger-detail')).toBeNull();
		expect(detail).toHaveClass('select-text');
		expect(detail).toHaveTextContent('jev-1.13.0');
		expect(detail).toHaveTextContent('proceed');
		expect(detail).toHaveTextContent('412 in, 3 out');
		expect(detail).toHaveTextContent('$0.000017');
		expect(detail).toHaveTextContent('Triage bot');
		expect(detail).toHaveTextContent('The input was not kept for this run.');
		expect(within(row).queryByTestId('system-one-ledger-input')).toBeNull();

		fireEvent.click(button);
		expect(button).toHaveAttribute('aria-expanded', 'false');
		expect(button).toHaveAttribute('title', 'Expand decision details');
		expect(chevron).not.toHaveClass('rotate-90');
		expect(within(row).queryByTestId('system-one-ledger-detail')).toBeNull();
	});

	it('shows a kept input, and why a run had no answer', async () => {
		ledger().mockResolvedValue(
			page({
				entries: [
					{ ...TIMED_OUT, input: '{"state":"A comment.","questions":{}}', agentId: 'gone-1234567' },
				],
				total: 1,
			})
		);
		await renderSection();
		const row = await screen.findByTestId('system-one-ledger-row');

		fireEvent.click(within(row).getByRole('button'));

		expect(within(row).getByTestId('system-one-ledger-input')).toHaveTextContent('A comment.');
		const detail = within(row).getByTestId('system-one-ledger-detail');
		expect(detail).toHaveTextContent('Why no answer');
		expect(detail).toHaveTextContent('Removed agent gone-123');
		expect(detail).not.toHaveTextContent('Tokens');
	});

	it('narrows by task and by outcome, keeping the other filter', async () => {
		await renderSection();
		expect(ledger()).toHaveBeenLastCalledWith({});

		fireEvent.change(screen.getByTestId('system-one-ledger-task'), {
			target: { value: 'cue-gate' },
		});
		await waitFor(() => expect(ledger()).toHaveBeenLastCalledWith({ taskId: 'cue-gate' }));

		fireEvent.change(screen.getByTestId('system-one-ledger-outcome'), {
			target: { value: 'timeout' },
		});
		await waitFor(() =>
			expect(ledger()).toHaveBeenLastCalledWith({ taskId: 'cue-gate', outcome: 'timeout' })
		);

		fireEvent.change(screen.getByTestId('system-one-ledger-task'), { target: { value: '' } });
		await waitFor(() => expect(ledger()).toHaveBeenLastCalledWith({ outcome: 'timeout' }));
	});

	it('offers only the tasks that take System One, and every outcome filter', async () => {
		await renderSection();

		const tasks = within(screen.getByTestId('system-one-ledger-task'))
			.getAllByRole('option')
			.map((option) => option.textContent);
		expect(tasks).toEqual([
			'All tasks',
			...LOCAL_MODEL_TASK_IDS.map((taskId) => LOCAL_MODEL_TASKS[taskId])
				.filter(taskAcceptsSystemOne)
				.map((task) => task.label),
		]);
		expect(tasks).toContain('Cue gate');
		// A System Two task never reaches the ledger, so it is not offered.
		expect(tasks).not.toContain(LOCAL_MODEL_TASKS['tab-naming'].label);
		const outcomes = within(screen.getByTestId('system-one-ledger-outcome'))
			.getAllByRole('option')
			.map((option) => option.textContent);
		expect(outcomes).toEqual([
			'All outcomes',
			'Answered',
			'Failed open',
			'Failed closed',
			'No answer',
			'Cancelled',
			'Timed out',
		]);
	});

	it('reads again on Refresh', async () => {
		await renderSection();
		await screen.findAllByTestId('system-one-ledger-row');
		const reads = ledger().mock.calls.length;

		fireEvent.click(screen.getByTestId('system-one-ledger-refresh'));

		await waitFor(() => expect(ledger().mock.calls.length).toBe(reads + 1));
	});

	it('says the ledger is empty, or that nothing matches a filter', async () => {
		ledger().mockResolvedValue(page({ entries: [], total: 0 }));
		await renderSection();

		expect(await screen.findByTestId('system-one-ledger-empty')).toHaveTextContent(
			'No decisions in the last 30 days.'
		);

		fireEvent.change(screen.getByTestId('system-one-ledger-outcome'), {
			target: { value: 'cancelled' },
		});
		await waitFor(() =>
			expect(screen.getByTestId('system-one-ledger-empty')).toHaveTextContent('No decisions match.')
		);
	});

	it('shows why decisions are not kept, and a read that failed', async () => {
		ledger().mockResolvedValue(
			page({ notice: 'Usage statistics are switched off, so new decisions are not kept.' })
		);
		await renderSection();
		expect(await screen.findByTestId('system-one-ledger-notice')).toHaveTextContent(
			'Usage statistics are switched off'
		);

		ledger().mockRejectedValue(new Error('The statistics database is locked.'));
		fireEvent.click(screen.getByTestId('system-one-ledger-refresh'));

		expect(await screen.findByTestId('system-one-ledger-error')).toHaveTextContent(
			'The statistics database is locked.'
		);
	});

	it('says how to read the rest when more match than are shown', async () => {
		ledger().mockResolvedValue(page({ total: 250 }));
		await renderSection();

		expect(await screen.findByTestId('system-one-ledger-more')).toHaveTextContent(
			'Showing the newest 2 of 250. Read the rest with: maestro-cli s1 ledger --limit 250'
		);
	});

	describe('Keep inputs in the ledger', () => {
		it('is off by default and says what a record keeps', async () => {
			await renderSection();

			const row = screen.getByTestId('system-one-keep-inputs');
			expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
			expect(row).toHaveTextContent(SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS.off);
		});

		it('turns on through the settings change the CLI makes too', async () => {
			const systemOne = hook();
			await renderSection(systemOne);

			fireEvent.click(screen.getByRole('switch', { name: 'Keep inputs in the ledger' }));

			expect(systemOne.set).toHaveBeenCalledWith({ keepInputs: true });
		});

		it('shows on, with what that keeps, and turns off', async () => {
			const systemOne = hook({ report: report(true) });
			await renderSection(systemOne);

			const row = screen.getByTestId('system-one-keep-inputs');
			expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
			expect(row).toHaveTextContent(SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS.on);

			fireEvent.click(within(row).getByRole('switch'));
			expect(systemOne.set).toHaveBeenCalledWith({ keepInputs: false });
		});

		it('waits for the report, and for a change in flight', async () => {
			const { unmount } = await renderSection(hook({ report: null }));
			expect(screen.getByRole('switch')).toBeDisabled();
			unmount();

			await renderSection(hook({ busy: 'set' }));
			expect(screen.getByRole('switch')).toBeDisabled();
		});
	});
});

describe('formatLedgerInput', () => {
	it('indents the JSON the ledger wrote', () => {
		expect(formatLedgerInput('{"state":"text","questions":{}}')).toBe(
			'{\n  "state": "text",\n  "questions": {}\n}'
		);
	});

	it('shows anything else as it was stored', () => {
		expect(formatLedgerInput('not json')).toBe('not json');
	});
});
