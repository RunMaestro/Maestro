/**
 * @fileoverview The Tab Cleanup Suggestions modal flow.
 *
 * The modal is the only place a model's suggestion can become an action, so
 * what is pinned here is the consent: every row starts unticked, Apply does
 * nothing until a row is ticked, only ticked rows are acted on, and a tab that
 * is busy, starred, or drafting right now cannot be ticked at all. The apply
 * step runs against the real session store, so "closed" means the tab left it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../../renderer/utils/snoozeTranscriptMirror', () => ({
	mirrorSnoozedTranscript: vi.fn(),
	releaseSnoozedTranscript: vi.fn(),
}));

vi.mock('../../../renderer/stores/snoozeHistoryStore', () => ({
	recordSnoozeResolution: vi.fn(),
	useSnoozeHistoryStore: { getState: () => ({ entries: [] }) },
}));

const notifyCenterFlash = vi.fn();
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: (...args: unknown[]) => notifyCenterFlash(...args),
}));

const notifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));

vi.mock('../../../renderer/services/snoozeWakePrompt', () => ({
	runSnoozeWakePrompt: vi.fn(),
	runSnoozeWakePromptAfterGroupWake: vi.fn(),
}));

vi.mock('../../../renderer/utils/starredSessions', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/starredSessions')>()),
	snapshotClosedTabTranscript: vi.fn(),
}));

const openSettings = vi.fn();
vi.mock('../../../renderer/stores/modalStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/modalStore')>()),
	getModalActions: () => ({ openSettings }),
}));

import { TabCleanupModal } from '../../../renderer/components/TabCleanupModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore, updateAiTab } from '../../../renderer/stores/sessionStore';
import { mockTheme } from '../../helpers/mockTheme';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AITab, Session } from '../../../renderer/types';
import type { TabCleanupResult, TabCleanupSuggestion } from '../../../shared/tabCleanup';

const DAY = 24 * 60 * 60 * 1000;

function agentWith(id: string, name: string, tabs: AITab[]): Session {
	return createMockSession({
		id,
		name,
		aiTabs: tabs,
		unifiedTabOrder: tabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		activeTabId: tabs[0]?.id,
	});
}

function suggestion(overrides: Partial<TabCleanupSuggestion> = {}): TabCleanupSuggestion {
	return {
		tabId: 't1',
		agentId: 'a1',
		action: 'close',
		reason: 'Untouched for a month.',
		agentName: 'Backend',
		label: 'Fix login bug',
		kind: 'open',
		tabType: 'ai',
		lastActivityAt: Date.now() - 30 * DAY,
		messageCount: 4,
		...overrides,
	};
}

function ok(suggestions: TabCleanupSuggestion[], extra: Record<string, unknown> = {}) {
	return {
		success: true,
		suggestions,
		considered: 5,
		protectedCount: 1,
		droppedCount: 0,
		truncated: false,
		producedBy: 'qwen3:latest on Ollama',
		...extra,
	} as TabCleanupResult;
}

const suggestTabCleanup = () => vi.mocked(window.maestro.localModels.suggestTabCleanup);

function tabIds(sessionId: string): string[] {
	return useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId)!
		.aiTabs.map((tab) => tab.id);
}

function renderModal() {
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<TabCleanupModal theme={mockTheme} onClose={onClose} />
		</LayerStackProvider>
	);
	return { onClose };
}

async function rows() {
	return screen.findAllByTestId('tab-cleanup-row');
}

function checkboxOf(row: HTMLElement): HTMLInputElement {
	return within(row).getByRole('checkbox') as HTMLInputElement;
}

const CLOSE_T1 = suggestion();
const SNOOZE_T2 = suggestion({
	tabId: 't2',
	action: 'snooze',
	label: 'Rewrite the guide',
	reason: 'Paused and not finished.',
});
const CLOSE_T3 = suggestion({
	tabId: 't3',
	agentId: 'a2',
	agentName: 'Docs',
	label: 'Old notes',
	reason: 'Empty tab.',
});

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({
		sessions: [
			agentWith('a1', 'Backend', [
				createMockAITab({ id: 't1', name: 'Fix login bug' }),
				createMockAITab({ id: 't2', name: 'Rewrite the guide' }),
			]),
			agentWith('a2', 'Docs', [
				createMockAITab({ id: 't3', name: 'Old notes' }),
				createMockAITab({ id: 't4', name: 'Keep me' }),
			]),
		],
		activeSessionId: 'a1',
	});
	suggestTabCleanup().mockResolvedValue(ok([CLOSE_T1, SNOOZE_T2, CLOSE_T3]));
});

describe('TabCleanupModal', () => {
	it('asks for suggestions when it opens and shows a spinner until they arrive', async () => {
		let resolve!: (value: TabCleanupResult) => void;
		suggestTabCleanup().mockReturnValue(new Promise((r) => (resolve = r)));

		renderModal();

		expect(screen.getByTestId('tab-cleanup-loading')).toBeInTheDocument();
		expect(suggestTabCleanup()).toHaveBeenCalledTimes(1);

		resolve(ok([CLOSE_T1]));
		expect(await rows()).toHaveLength(1);
		expect(screen.queryByTestId('tab-cleanup-loading')).not.toBeInTheDocument();
	});

	it('lists each suggestion with its action, tab, agent, and reason', async () => {
		renderModal();

		const [first, second, third] = await rows();
		expect(within(first).getByText('Close')).toBeInTheDocument();
		expect(within(first).getByText('Fix login bug')).toBeInTheDocument();
		expect(within(first).getByText('Backend')).toBeInTheDocument();
		expect(within(first).getByText('Untouched for a month.')).toBeInTheDocument();
		expect(within(first).getByText(/last active 4 weeks ago/)).toBeInTheDocument();
		expect(within(first).getByText('4 messages')).toBeInTheDocument();
		expect(within(second).getByText('Snooze')).toBeInTheDocument();
		expect(within(third).getByText('Docs')).toBeInTheDocument();
		expect(screen.getByTestId('tab-cleanup-coverage')).toHaveTextContent(
			'5 tabs reviewed, 1 left out (busy, starred, or with a draft). Suggested by qwen3:latest on Ollama.'
		);
	});

	it('starts with nothing ticked and Apply disabled', async () => {
		renderModal();

		for (const row of await rows()) expect(checkboxOf(row).checked).toBe(false);
		expect(screen.getByTestId('tab-cleanup-apply')).toBeDisabled();
		expect(screen.getByTestId('tab-cleanup-apply')).toHaveTextContent('Apply');
	});

	it('applies only the ticked rows, each on the agent it names', async () => {
		const { onClose } = renderModal();

		const [, , third] = await rows();
		fireEvent.click(checkboxOf(third));
		expect(screen.getByTestId('tab-cleanup-apply')).toHaveTextContent('Apply 1');
		fireEvent.click(screen.getByTestId('tab-cleanup-apply'));

		expect(tabIds('a2')).toEqual(['t4']);
		expect(tabIds('a1')).toEqual(['t1', 't2']);
		expect(notifyCenterFlash).toHaveBeenCalledWith({ message: 'Closed 1', color: 'green' });
		// Two suggestions are still on the list, so the modal stays.
		expect(onClose).not.toHaveBeenCalled();
		await waitFor(async () => expect(await rows()).toHaveLength(2));
		expect(screen.queryByText('Old notes')).not.toBeInTheDocument();
		expect(screen.getByTestId('tab-cleanup-apply')).toBeDisabled();
	});

	it('closes itself once every suggestion has been applied', async () => {
		suggestTabCleanup().mockResolvedValue(ok([CLOSE_T1]));
		const { onClose } = renderModal();

		const [only] = await rows();
		fireEvent.click(checkboxOf(only));
		fireEvent.click(screen.getByTestId('tab-cleanup-apply'));

		expect(tabIds('a1')).toEqual(['t2']);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('snoozes a ticked row until the chosen preset', async () => {
		renderModal();

		const [, second] = await rows();
		const until = screen.getByTestId('tab-cleanup-snooze-until') as HTMLSelectElement;
		// The picker is there because a snooze is on the list, but inert until one is ticked.
		expect(until).toBeDisabled();
		fireEvent.click(checkboxOf(second));
		expect(until).not.toBeDisabled();
		fireEvent.change(until, { target: { value: 'nextWeek' } });
		const before = Date.now();
		fireEvent.click(screen.getByTestId('tab-cleanup-apply'));

		const a1 = useSessionStore.getState().sessions.find((s) => s.id === 'a1')!;
		expect(a1.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		expect(a1.snoozedTabs).toHaveLength(1);
		expect(a1.snoozedTabs![0].tab).toMatchObject({ id: 't2' });
		// "Next week" is the coming Monday morning. Not `before + DAY`: on a Sunday
		// that Monday is under a day away, so the test failed one day in seven.
		const wakeAt = a1.snoozedTabs![0].wakeAt;
		expect(wakeAt).toBeGreaterThan(before);
		expect(new Date(wakeAt).getDay()).toBe(1);
		expect(notifyCenterFlash).toHaveBeenCalledWith({ message: 'Snoozed 1', color: 'green' });
	});

	it('offers no snooze time when no snooze is suggested', async () => {
		suggestTabCleanup().mockResolvedValue(ok([CLOSE_T1]));
		renderModal();

		await rows();
		expect(screen.queryByTestId('tab-cleanup-snooze-until')).not.toBeInTheDocument();
	});

	it('ticks and unticks every row with Select all', async () => {
		renderModal();

		const all = await rows();
		fireEvent.click(screen.getByTestId('tab-cleanup-select-all'));
		for (const row of all) expect(checkboxOf(row).checked).toBe(true);
		expect(screen.getByTestId('tab-cleanup-apply')).toHaveTextContent('Apply 3');

		fireEvent.click(screen.getByTestId('tab-cleanup-select-all'));
		for (const row of all) expect(checkboxOf(row).checked).toBe(false);
	});

	it.each([
		['starred', { starred: true }, 'This tab is starred.'],
		['drafting', { inputValue: 'half a thought' }, 'This tab has an unsent draft.'],
		['busy', { state: 'busy' as const }, 'The agent is working in this tab.'],
	])('draws a %s tab disabled and never applies it', async (_name, patch, message) => {
		updateAiTab('a1', 't1', (tab) => ({ ...tab, ...patch }));
		renderModal();

		const [first] = await rows();
		expect(checkboxOf(first)).toBeDisabled();
		expect(within(first).getByText(new RegExp(message.replace('.', '\\.')))).toBeInTheDocument();

		// Select all skips it too.
		fireEvent.click(screen.getByTestId('tab-cleanup-select-all'));
		expect(checkboxOf(first).checked).toBe(false);
		expect(screen.getByTestId('tab-cleanup-apply')).toHaveTextContent('Apply 2');
		fireEvent.click(screen.getByTestId('tab-cleanup-apply'));

		expect(tabIds('a1')).toContain('t1');
	});

	it('unticks a row whose tab becomes busy while the modal is open', async () => {
		renderModal();

		const [first] = await rows();
		fireEvent.click(checkboxOf(first));
		expect(screen.getByTestId('tab-cleanup-apply')).toHaveTextContent('Apply 1');

		updateAiTab('a1', 't1', (tab) => ({ ...tab, state: 'busy' }));

		await waitFor(() => expect(screen.getByTestId('tab-cleanup-apply')).toBeDisabled());
		expect(checkboxOf((await rows())[0])).toBeDisabled();
		expect(tabIds('a1')).toContain('t1');
	});

	it('does not draw a suggestion for a tab that is already gone', async () => {
		suggestTabCleanup().mockResolvedValue(ok([CLOSE_T1, suggestion({ tabId: 'closed-earlier' })]));
		renderModal();

		expect(await rows()).toHaveLength(1);
	});

	it('says there is nothing to clean up when the list is empty', async () => {
		suggestTabCleanup().mockResolvedValue(ok([]));
		renderModal();

		expect(await screen.findByText('Nothing to clean up')).toBeInTheDocument();
		expect(screen.getByTestId('tab-cleanup-apply')).toBeDisabled();
	});

	it('explains that the task is off and leads to its setting', async () => {
		suggestTabCleanup().mockResolvedValue({
			success: false,
			status: 'off',
			error: 'Tab cleanup suggestions is off. Assign it a local model or an endpoint.',
		});
		const { onClose } = renderModal();

		expect(await screen.findByText('Tab cleanup suggestions is off')).toBeInTheDocument();
		expect(screen.getByText(/Assign it a local model or an endpoint/)).toBeInTheDocument();

		fireEvent.click(screen.getByText('Open Models Settings'));

		expect(onClose).toHaveBeenCalledTimes(1);
		// tab-cleanup is a System One task, so its assignment lives in that inner tab.
		expect(openSettings).toHaveBeenCalledWith('models', undefined, 'system-one');
	});

	it('shows why a run failed, and a rejected call as a failure rather than a crash', async () => {
		suggestTabCleanup().mockRejectedValue(new Error('IPC channel closed'));
		renderModal();

		expect(await screen.findByText('No suggestions this time')).toBeInTheDocument();
		expect(screen.getByText('IPC channel closed')).toBeInTheDocument();
	});

	it('asks again on Refresh and drops the earlier ticks', async () => {
		renderModal();

		const [first] = await rows();
		fireEvent.click(checkboxOf(first));
		suggestTabCleanup().mockResolvedValue(ok([CLOSE_T3]));
		fireEvent.click(screen.getByText('Refresh'));

		await waitFor(async () => expect(await rows()).toHaveLength(1));
		expect(suggestTabCleanup()).toHaveBeenCalledTimes(2);
		expect(checkboxOf((await rows())[0]).checked).toBe(false);
		expect(screen.getByText('Old notes')).toBeInTheDocument();
	});

	it('closes on Escape and on Cancel without touching a tab', async () => {
		const { onClose } = renderModal();
		const [first] = await rows();
		fireEvent.click(checkboxOf(first));

		fireEvent.click(screen.getByText('Cancel'));
		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
		expect(tabIds('a1')).toEqual(['t1', 't2']);
	});
});
