/**
 * PlaybookCompletionModal: shows the oldest waiting report with "1 of N" when
 * more wait, Done and Escape advance the queue, and Copy, Save to project, and
 * a clicked path act on the report on screen.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybookCompletionModal } from '../../../../renderer/components/PlaybookCompletionModal/PlaybookCompletionModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { usePlaybookCompletionStore } from '../../../../renderer/stores/playbookCompletionStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import {
	buildFinalSummaryFacts,
	renderPlaybookReportMarkdown,
	type PlaybookRunReport,
	type PlaybookRunReportStatus,
} from '../../../../shared/playbookRunReport';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

const markdownProps: Array<{ content: string; onFileClick?: (path: string) => void }> = [];
vi.mock('../../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: (props: { content: string; onFileClick?: (path: string) => void }) => {
		markdownProps.push(props);
		return <div data-testid="markdown-renderer">{props.content}</div>;
	},
}));

const clipboard = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: clipboard.write,
}));

const flash = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: flash,
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<object>()),
	notifyToast: toast,
}));

function makeReport(
	playbookName: string,
	status: PlaybookRunReportStatus = 'completed',
	overrides: Partial<PlaybookRunReport> = {}
): PlaybookRunReport {
	const stalled: Map<string, string> =
		status === 'partial' ? new Map([['pb/two', 'No progress']]) : new Map();
	return {
		playbookName,
		status,
		facts: buildFinalSummaryFacts({
			wasStopped: status === 'stopped',
			totalCompletedTasks: 3,
			totalElapsedMs: 65_000,
			stalledDocuments: stalled,
			documents: [{ filename: 'pb/one' }, { filename: 'pb/two' }],
			loopEnabled: false,
			loopIteration: 0,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			totalCost: 0.02,
		}),
		howToUse: 'Run `npm start`.',
		nextSteps: ['Send a message'],
		evidence: {
			source: 'git',
			changedFiles: ['src/a.ts'],
			createdFiles: [],
			deletedFiles: [],
		},
		parameters: [{ name: 'PORT', value: '8080', source: 'default' }],
		startedAt: 0,
		finishedAt: 65_000,
		cwd: '/project',
		...overrides,
	};
}

const store = () => usePlaybookCompletionStore.getState();
const fs = () => window.maestro.fs as unknown as { writeFile: ReturnType<typeof vi.fn> };

function renderModal() {
	return render(
		<LayerStackProvider>
			<PlaybookCompletionModal theme={mockTheme} />
		</LayerStackProvider>
	);
}

describe('PlaybookCompletionModal', () => {
	beforeEach(() => {
		markdownProps.length = 0;
		clipboard.write.mockReset().mockResolvedValue(true);
		flash.mockReset();
		toast.mockReset();
		fs().writeFile.mockReset().mockResolvedValue({ success: true });
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'agent-1', name: 'Agent One', cwd: '/project' })],
		});
		act(() => store().clear());
	});

	afterEach(() => {
		act(() => store().clear());
	});

	it('renders nothing while no report is waiting', () => {
		renderModal();
		expect(screen.queryByTestId('playbook-completion-modal')).toBeNull();
	});

	it('shows the oldest report with "1 of N", and Done advances to the next', () => {
		renderModal();
		act(() => {
			store().enqueue('agent-1', makeReport('First'));
			store().enqueue('agent-1', makeReport('Second', 'partial'));
		});

		expect(screen.getByText('First')).toBeInTheDocument();
		expect(screen.getByTestId('playbook-completion-status')).toHaveTextContent('Completed');
		expect(screen.getByTestId('playbook-completion-position')).toHaveTextContent('1 of 2');

		fireEvent.click(screen.getByTestId('playbook-completion-done'));

		expect(screen.getByText('Second')).toBeInTheDocument();
		expect(screen.getByTestId('playbook-completion-status')).toHaveTextContent(
			'Partially completed'
		);
		expect(screen.queryByTestId('playbook-completion-position')).toBeNull();

		fireEvent.click(screen.getByTestId('playbook-completion-done'));
		expect(screen.queryByTestId('playbook-completion-modal')).toBeNull();
	});

	it('treats Escape as Done', async () => {
		renderModal();
		act(() => {
			store().enqueue('agent-1', makeReport('First'));
			store().enqueue('agent-1', makeReport('Second'));
		});

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
		});

		expect(store().queue).toHaveLength(1);
		expect(screen.getByText('Second')).toBeInTheDocument();
	});

	it('puts what did not happen above what was done, and folds evidence and configuration into Details', () => {
		renderModal();
		act(() => store().enqueue('agent-1', makeReport('Partial', 'partial')));

		const [body, details] = markdownProps.slice(-2).map((p) => p.content);
		expect(body.indexOf('## What did not happen')).toBeGreaterThanOrEqual(0);
		expect(body.indexOf('## What did not happen')).toBeLessThan(body.indexOf('## What was done'));
		expect(body).toContain('## How to use it');
		expect(body).toContain('## Next steps');
		expect(body).not.toContain('## Files changed');
		expect(details).toContain('## Files changed');
		expect(details).toContain('## Configuration');
		expect(screen.getByTestId('playbook-completion-details')).not.toHaveAttribute('open');
	});

	it('offers "Report a problem" (disabled) only when the run did not complete', () => {
		renderModal();
		act(() => store().enqueue('agent-1', makeReport('Fine')));
		expect(screen.queryByTestId('playbook-completion-report-problem')).toBeNull();

		act(() => {
			store().clear();
			store().enqueue('agent-1', makeReport('Broken', 'failed'));
		});
		expect(screen.getByTestId('playbook-completion-report-problem')).toBeDisabled();
	});

	it('copies the rendered report and flashes the acknowledgement', async () => {
		renderModal();
		const report = makeReport('Copy Me');
		act(() => store().enqueue('agent-1', report));

		fireEvent.click(screen.getByTestId('playbook-completion-copy'));

		await waitFor(() => expect(flash).toHaveBeenCalled());
		expect(clipboard.write).toHaveBeenCalledWith(renderPlaybookReportMarkdown(report));
		// Copying is not reading: the report stays on screen.
		expect(store().queue).toHaveLength(1);
	});

	it('says so when the clipboard refuses', async () => {
		clipboard.write.mockResolvedValueOnce(false);
		renderModal();
		act(() => store().enqueue('agent-1', makeReport('Copy Me')));

		fireEvent.click(screen.getByTestId('playbook-completion-copy'));

		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Copy failed' }))
		);
		expect(flash).not.toHaveBeenCalled();
	});

	it("saves the report into the agent's working directory and toasts the path", async () => {
		renderModal();
		const report = makeReport('Message Bus');
		act(() => store().enqueue('agent-1', report));

		fireEvent.click(screen.getByTestId('playbook-completion-save'));

		await waitFor(() => expect(toast).toHaveBeenCalled());
		const [path, content, sshRemoteId] = fs().writeFile.mock.calls[0];
		expect(path).toMatch(/^\/project\/message-bus-REPORT-\d{8}-\d{6}\.md$/);
		expect(content).toBe(renderPlaybookReportMarkdown(report));
		expect(sshRemoteId).toBeUndefined();
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'green',
				title: 'Report saved',
				message: path,
				clickAction: { kind: 'open-file', sessionId: 'agent-1', path },
			})
		);
	});

	it('reports a failed save instead of claiming success', async () => {
		fs().writeFile.mockResolvedValueOnce({ success: false });
		renderModal();
		act(() => store().enqueue('agent-1', makeReport('Message Bus')));

		fireEvent.click(screen.getByTestId('playbook-completion-save'));

		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'red', title: 'Report not saved' })
			)
		);
	});

	it('disables Save when the agent that ran the playbook is gone', () => {
		renderModal();
		act(() => store().enqueue('agent-gone', makeReport('Orphan')));
		expect(screen.getByTestId('playbook-completion-save')).toBeDisabled();
	});

	it("opens a clicked path in the agent's File Preview, resolved against the run's cwd", () => {
		const listener = vi.fn();
		window.addEventListener('maestro:openFileTab', listener);
		renderModal();
		act(() => store().enqueue('agent-1', makeReport('Paths', 'completed', { cwd: '/work/tree' })));

		act(() => markdownProps.at(-1)?.onFileClick?.('src/a.ts'));

		const detail = (listener.mock.calls[0][0] as CustomEvent).detail;
		expect(detail).toEqual({ sessionId: 'agent-1', filePath: '/work/tree/src/a.ts' });
		// The file opens beneath the modal, so the report steps aside.
		expect(store().queue).toHaveLength(0);
		window.removeEventListener('maestro:openFileTab', listener);
	});
});
