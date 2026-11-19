/**
 * PlaybookCompletionModal: shows the oldest waiting report with "1 of N" when
 * more wait, Done and Escape advance the queue, and Copy, Save to project, and
 * a clicked path act on the report on screen. The one-time telemetry consent
 * step leads a live official completion and records either answer.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybookCompletionModal } from '../../../../renderer/components/PlaybookCompletionModal/PlaybookCompletionModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { usePlaybookCompletionStore } from '../../../../renderer/stores/playbookCompletionStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	buildFinalSummaryFacts,
	renderPlaybookReportMarkdown,
	type PlaybookRunReport,
	type PlaybookRunReportStatus,
} from '../../../../shared/playbookRunReport';
import type { PlaybookTelemetryRunCompletedEvent } from '../../../../shared/playbookTelemetry';
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

		const [card, body, details] = markdownProps.slice(-3).map((p) => p.content);
		expect(card).toMatch(/^## What did not happen/);
		expect(card).toContain('`pb/two`: No progress');
		expect(body).toMatch(/^## What was done/);
		expect(body).toContain('## How to use it');
		expect(body).toContain('## Next steps');
		expect(body).not.toContain('## Files changed');
		expect(details).toContain('## Files changed');
		expect(details).toContain('## Configuration');
		// The card is drawn above the narrative, not merely before it in a string.
		const cardEl = screen.getByTestId('playbook-report-not-done');
		const mainEl = screen.getByTestId('playbook-report-main');
		expect(cardEl.compareDocumentPosition(mainEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByTestId('playbook-report-details')).not.toHaveAttribute('open');
	});

	it('draws the last error with its document and task in the failure card', () => {
		renderModal();
		act(() =>
			store().enqueue(
				'agent-1',
				makeReport('Broken', 'failed', {
					problems: [
						{ kind: 'error', document: 'pb/one', taskIndex: 1, message: 'Context limit reached' },
					],
				})
			)
		);
		expect(screen.getByTestId('playbook-report-not-done')).toHaveTextContent(
			'**The run hit an error** at task 2 of `pb/one`: Context limit reached'
		);
	});

	it('has no failure card for a completed run', () => {
		renderModal();
		act(() => store().enqueue('agent-1', makeReport('Fine')));
		expect(screen.queryByTestId('playbook-report-not-done')).toBeNull();
	});

	it('offers "Report a problem" only when the run did not complete, disabled for a local playbook', () => {
		renderModal();
		act(() => store().enqueue('agent-1', makeReport('Fine')));
		expect(screen.queryByTestId('playbook-completion-report-problem')).toBeNull();

		act(() => {
			store().clear();
			store().enqueue('agent-1', makeReport('Broken', 'failed'));
		});
		expect(screen.getByTestId('playbook-completion-report-problem')).toBeDisabled();
	});

	describe('Report a problem', () => {
		const PREVIEW = {
			repo: 'RunMaestro/Maestro-Playbooks',
			title: 'Playbook research-market: stalled at two.md task 3',
			body: '## Playbook failure\n\n| Playbook | `research-market` |',
			fingerprint: '0123456789abcdef',
		};
		const feedback = () =>
			window.maestro.feedback as unknown as {
				previewPlaybookFailure: ReturnType<typeof vi.fn>;
				submitPlaybookFailure: ReturnType<typeof vi.fn>;
			};
		const readDoc = () =>
			(window.maestro.autorun as unknown as { readDoc: ReturnType<typeof vi.fn> }).readDoc;
		const openExternal = () =>
			(window.maestro.shell as unknown as { openExternal: ReturnType<typeof vi.fn> }).openExternal;

		const exchangeReport = (status: PlaybookRunReportStatus = 'partial') =>
			makeReport('Research', status, {
				source: { marketplaceId: 'research-market', sourceVersion: '2026-08-14' },
				autoRunFolderPath: '/autorun',
				problems: [{ kind: 'stall', document: 'pb/two', taskIndex: 2, message: 'No progress' }],
			});

		beforeEach(() => {
			feedback().previewPlaybookFailure.mockReset().mockResolvedValue(PREVIEW);
			feedback().submitPlaybookFailure.mockReset().mockResolvedValue({
				success: true,
				repo: PREVIEW.repo,
				issueUrl: 'https://github.com/RunMaestro/Maestro-Playbooks/issues/12',
			});
			readDoc().mockReset().mockResolvedValue({ success: true, content: '- [ ] shipped task' });
			openExternal().mockReset();
		});

		async function openReportStep() {
			renderModal();
			act(() => store().enqueue('agent-1', exchangeReport()));
			const button = screen.getByTestId('playbook-completion-report-problem');
			expect(button).not.toBeDisabled();
			fireEvent.click(button);
			await waitFor(() => screen.getByTestId('playbook-failure-preview-body'));
		}

		it('shows the exact issue body, read from the pristine copy, before sending anything', async () => {
			await openReportStep();

			expect(readDoc()).toHaveBeenCalledWith(
				'/autorun',
				'pb/.maestro-playbook/source/two.md',
				undefined
			);
			expect(feedback().previewPlaybookFailure).toHaveBeenCalledWith({
				report: expect.objectContaining({
					playbookId: 'research-market',
					sourceVersion: '2026-08-14',
					documentFilename: 'two',
					taskIndex: 2,
					kind: 'stall',
				}),
				pristineSource: '- [ ] shipped task',
			});
			expect(screen.getByTestId('playbook-failure-preview-body').textContent).toBe(PREVIEW.body);
			expect(screen.getByTestId('playbook-failure-preview-title').textContent).toBe(PREVIEW.title);
			expect(screen.getByTestId('playbook-failure-include-debug-package')).not.toBeChecked();
			expect(feedback().submitPlaybookFailure).not.toHaveBeenCalled();
		});

		it('files with the support package off by default, then returns to the report', async () => {
			await openReportStep();
			fireEvent.click(screen.getByTestId('playbook-failure-send'));

			await waitFor(() => expect(feedback().submitPlaybookFailure).toHaveBeenCalled());
			expect(feedback().submitPlaybookFailure).toHaveBeenCalledWith(
				expect.objectContaining({
					includeDebugPackage: false,
					pristineSource: '- [ ] shipped task',
				})
			);
			await waitFor(() => expect(screen.queryByTestId('playbook-failure-report-step')).toBeNull());
			expect(toast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'green', title: 'Problem reported' })
			);
		});

		it('attaches the support package only when ticked', async () => {
			await openReportStep();
			fireEvent.click(screen.getByTestId('playbook-failure-include-debug-package'));
			fireEvent.click(screen.getByTestId('playbook-failure-send'));

			await waitFor(() =>
				expect(feedback().submitPlaybookFailure).toHaveBeenCalledWith(
					expect.objectContaining({ includeDebugPackage: true })
				)
			);
		});

		it('says so when the failure was already reported', async () => {
			feedback().submitPlaybookFailure.mockResolvedValue({
				success: true,
				repo: PREVIEW.repo,
				issueUrl: 'https://github.com/RunMaestro/Maestro-Playbooks/issues/77',
				deduplicated: true,
			});
			await openReportStep();
			fireEvent.click(screen.getByTestId('playbook-failure-send'));

			await waitFor(() =>
				expect(toast).toHaveBeenCalledWith(
					expect.objectContaining({
						title: 'Already reported',
						clickAction: {
							kind: 'open-url',
							url: 'https://github.com/RunMaestro/Maestro-Playbooks/issues/77',
						},
					})
				)
			);
		});

		it('without gh, opens the prefilled issue and copies the overflow to the clipboard', async () => {
			feedback().submitPlaybookFailure.mockResolvedValue({
				success: false,
				repo: PREVIEW.repo,
				error: 'GitHub CLI (gh) is not installed.',
				browserFallback: { url: 'https://github.com/x/y/issues/new?title=t', overflow: 'the rest' },
			});
			await openReportStep();
			fireEvent.click(screen.getByTestId('playbook-failure-send'));

			await waitFor(() =>
				expect(openExternal()).toHaveBeenCalledWith('https://github.com/x/y/issues/new?title=t')
			);
			expect(clipboard.write).toHaveBeenCalledWith('the rest');
			expect(toast).toHaveBeenCalledWith(
				expect.objectContaining({
					color: 'yellow',
					title: 'Finish the report in your browser',
					message: expect.stringContaining('the rest is on your clipboard'),
				})
			);
			await waitFor(() => expect(screen.queryByTestId('playbook-failure-report-step')).toBeNull());
		});

		it('Back returns to the report without sending', async () => {
			await openReportStep();
			fireEvent.click(screen.getByTestId('playbook-failure-back'));

			expect(screen.queryByTestId('playbook-failure-report-step')).toBeNull();
			expect(feedback().submitPlaybookFailure).not.toHaveBeenCalled();
			expect(store().queue).toHaveLength(1);
		});

		it('keeps "Report a problem" disabled for a stopped Exchange run', () => {
			renderModal();
			act(() => store().enqueue('agent-1', exchangeReport('stopped')));
			expect(screen.getByTestId('playbook-completion-report-problem')).toBeDisabled();
		});
	});

	describe('telemetry consent', () => {
		const event: PlaybookTelemetryRunCompletedEvent = {
			type: 'run_completed',
			ts: '2026-11-19T12:00:00.000Z',
			playbook_id: 'best-pr',
			source_version: '1.2.0',
			status: 'completed',
			duration_ms: 65_000,
			documents_total: 2,
			documents_stalled: 0,
		};
		const settings = () => useSettingsStore.getState();
		const resetConsent = () =>
			useSettingsStore.setState({
				playbookTelemetryEnabled: false,
				onboardingStats: { ...settings().onboardingStats, playbookTelemetryPromptShownAt: 0 },
			});

		beforeEach(resetConsent);
		afterEach(resetConsent);

		it('leads with the literal run_completed event before the report, and records that it was shown', () => {
			renderModal();
			act(() => store().enqueue('agent-1', makeReport('Official'), event));

			expect(screen.getByTestId('playbook-telemetry-consent-step')).toBeInTheDocument();
			expect(
				JSON.parse(screen.getByTestId('playbook-telemetry-consent-payload').textContent ?? '')
			).toEqual(event);
			expect(screen.queryByTestId('playbook-completion-done')).toBeNull();
			expect(settings().onboardingStats.playbookTelemetryPromptShownAt).toBeGreaterThan(0);
		});

		it('"Share anonymous usage" turns telemetry on and goes on to the report', () => {
			renderModal();
			act(() => store().enqueue('agent-1', makeReport('Official'), event));

			fireEvent.click(screen.getByTestId('playbook-telemetry-consent-accept'));

			expect(settings().playbookTelemetryEnabled).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('playbookTelemetryEnabled', true);
			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
			expect(screen.getByTestId('playbook-completion-done')).toBeInTheDocument();
			expect(store().queue).toHaveLength(1);
		});

		it('"No thanks" keeps telemetry off and goes on to the report', () => {
			renderModal();
			act(() => store().enqueue('agent-1', makeReport('Official'), event));

			fireEvent.click(screen.getByTestId('playbook-telemetry-consent-decline'));

			expect(settings().playbookTelemetryEnabled).toBe(false);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('playbookTelemetryEnabled', false);
			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
			expect(screen.getByTestId('playbook-completion-done')).toBeInTheDocument();
		});

		it('never returns once answered', () => {
			renderModal();
			act(() => {
				store().enqueue('agent-1', makeReport('First'), event);
				store().enqueue('agent-1', makeReport('Second'), event);
			});

			fireEvent.click(screen.getByTestId('playbook-telemetry-consent-decline'));
			fireEvent.click(screen.getByTestId('playbook-completion-done'));

			expect(screen.getByText('Second')).toBeInTheDocument();
			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
		});

		it('Escape skips to the report without answering, and the step does not return', async () => {
			renderModal();
			act(() => {
				store().enqueue('agent-1', makeReport('First'), event);
				store().enqueue('agent-1', makeReport('Second'), event);
			});

			await act(async () => {
				document.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
				);
			});

			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
			expect(screen.getByText('First')).toBeInTheDocument();
			expect(settings().playbookTelemetryEnabled).toBe(false);

			fireEvent.click(screen.getByTestId('playbook-completion-done'));
			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
		});

		it('is not offered without an event, for a stopped run, or when telemetry is already on', () => {
			renderModal();
			act(() => store().enqueue('agent-1', makeReport('Local')));
			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
			act(() => store().clear());

			act(() =>
				store().enqueue('agent-1', makeReport('Stopped', 'stopped'), {
					...event,
					status: 'stopped',
				})
			);
			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
			act(() => store().clear());

			act(() => useSettingsStore.setState({ playbookTelemetryEnabled: true }));
			act(() => store().enqueue('agent-1', makeReport('Opted in'), event));
			expect(screen.queryByTestId('playbook-telemetry-consent-step')).toBeNull();
			expect(settings().onboardingStats.playbookTelemetryPromptShownAt).toBe(0);
		});
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
