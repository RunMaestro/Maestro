/**
 * Tests for PlaybookOutroModal: what a launched playbook did, and what to do next.
 *
 * The words and numbers come from `buildLaunchOutro()` (its own suite), so these tests pin what a
 * person sees and does: how the run ended, the verdict cut from the report file, the author's
 * summary and next steps, one Open button per output file (which takes the person to the agent
 * that ran the playbook), the cleanup line, and Close and Run again.
 *
 * `reopenPlaybookLaunch` is a spy that calls the real service, which asks main for the manifest
 * through the mocked `window.maestro.marketplace.getManifest` and opens the launch dialog through
 * the real modal store. A test that needs a different outcome queues one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

// The renderer behind the text pulls in the whole remark stack; the dialog only has to reach it.
vi.mock('../../../../../renderer/components/Markdown', () => ({
	Markdown: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock('../../../../../renderer/services/playbookLaunch', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../../renderer/services/playbookLaunch')>();
	return { ...actual, reopenPlaybookLaunch: vi.fn(actual.reopenPlaybookLaunch) };
});

import { PlaybookOutroModal } from '../../../../../renderer/components/MarketplaceModal/launch/PlaybookOutroModal';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import * as playbookLaunchService from '../../../../../renderer/services/playbookLaunch';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { notifyToast } from '../../../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { resetPathExistenceCache } from '../../../../../renderer/utils/fileLinks/pathExistence';
import type {
	MarketplacePlaybook,
	PlaybookLaunchRecord,
} from '../../../../../shared/marketplace-types';
import { createMockLaunchRecord, createMockSession, resetStores } from '../../../../helpers';
import { mockTheme } from '../../../../helpers/mockTheme';

const reopenPlaybookLaunch = vi.mocked(playbookLaunchService.reopenPlaybookLaunch);
const readFile = vi.mocked(window.maestro.fs.readFile);
const stat = vi.mocked(window.maestro.fs.stat);
const getManifest = vi.mocked(window.maestro.marketplace.getManifest);

/** 2026-11-09 15:00 UTC: the same calendar day in every time zone the suite can run in. */
const STARTED_AT = Date.UTC(2026, 10, 9, 15, 0, 0);

const INDEX_PATH = '/runs/docs/INDEX.md';
const MAP_PATH = '/runs/docs/Map.md';

const REPORT_TEXT = [
	'# Market Index',
	'',
	'VERDICT: the vault is complete.',
	'',
	'## Contents',
	'',
	'Lots of it.',
].join('\n');

const ALPHA = createMockSession({ id: 'session-1', name: 'Alpha', cwd: '/work/alpha' });
const BETA = createMockSession({ id: 'session-2', name: 'Beta', cwd: '/work/beta' });

const STAT = {
	size: 1024,
	createdAt: '2026-11-09T15:00:00.000Z',
	modifiedAt: '2026-11-09T15:02:05.000Z',
	isDirectory: false,
	isFile: true,
};

/** A launch that completed: six tasks, two minutes, the documents removed. */
function launchRecord(overrides: Partial<PlaybookLaunchRecord> = {}): PlaybookLaunchRecord {
	return createMockLaunchRecord({
		playbookId: 'research-market',
		playbookTitle: 'Market Research',
		sessionId: 'session-1',
		autoRunFolderPath: '/runs/docs',
		folderRelativePath: 'research-market-launch-20261109-090000',
		status: 'completed',
		startedAt: STARTED_AT,
		finishedAt: STARTED_AT + 125_000,
		completion: {
			completedTasks: 6,
			totalTasks: 6,
			elapsedTimeMs: 125_000,
			totalCostUsd: 1.25,
			wasStopped: false,
		},
		cleanup: 'done',
		values: { MARKET_TOPIC: 'Edge AI' },
		spec: {
			inputs: [{ name: 'MARKET_TOPIC', label: 'Topic', type: 'text', required: true }],
			outro: {
				title: 'Market vault is ready',
				summary: 'The vault on **{{MARKET_TOPIC}}** was built by {{AGENT_NAME}}.',
				nextSteps: ['Start with `INDEX.md`.', 'Keep it current.'],
				files: [
					{ label: 'Index', path: '{{AUTORUN_FOLDER}}/INDEX.md' },
					{ label: 'Market map', path: '{{AUTORUN_FOLDER}}/Map.md' },
				],
				reportFile: '{{AUTORUN_FOLDER}}/INDEX.md',
			},
		},
		...overrides,
	});
}

/** A launch whose run was stopped at three of six tasks. */
function stoppedRecord(overrides: Partial<PlaybookLaunchRecord> = {}): PlaybookLaunchRecord {
	return launchRecord({
		status: 'stopped',
		completion: {
			completedTasks: 3,
			totalTasks: 6,
			elapsedTimeMs: 61_000,
			totalCostUsd: 0.4,
			wasStopped: true,
		},
		cleanup: 'skipped-stopped',
		...overrides,
	});
}

function renderOutro(launch: PlaybookLaunchRecord = launchRecord()) {
	const onClose = vi.fn();
	const onOpenFile = vi.fn();
	const view = render(
		<LayerStackProvider>
			<PlaybookOutroModal
				theme={mockTheme}
				launch={launch}
				onClose={onClose}
				onOpenFile={onOpenFile}
			/>
		</LayerStackProvider>
	);
	return { onClose, onOpenFile, ...view };
}

/** The text a markdown block was handed, newlines intact. */
function markdownIn(testId: string): string | null {
	return within(screen.getByTestId(testId)).getByTestId('markdown').textContent;
}

function openButton(label: string) {
	return screen.getByRole('button', { name: `Open ${label}` });
}

function exchangeLists(...playbooks: Array<Partial<MarketplacePlaybook>>) {
	getManifest.mockResolvedValue({
		success: true,
		manifest: { lastUpdated: '2026-11-11', playbooks: playbooks as MarketplacePlaybook[] },
		fromCache: true,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStores(useSessionStore);
	useSessionStore.setState({ sessions: [ALPHA, BETA], activeSessionId: 'session-1' });
	useModalStore.setState({ modals: new Map() });
	resetPathExistenceCache();
	readFile.mockReset();
	readFile.mockImplementation(async (path: string) => (path === INDEX_PATH ? REPORT_TEXT : null));
	stat.mockReset();
	stat.mockResolvedValue(STAT);
	getManifest.mockReset();
	exchangeLists();
});

describe('PlaybookOutroModal', () => {
	describe('the dialog', () => {
		it('is a dialog titled with the playbook author title, in a portal, with a remembered size', () => {
			renderOutro();

			const overlay = screen.getByTestId('playbook-outro-modal');
			expect(overlay).toHaveAttribute('role', 'dialog');
			expect(overlay).toHaveAttribute('aria-label', 'Market vault is ready');
			expect(overlay.parentElement).toBe(document.body);
			expect(overlay).toHaveStyle({ zIndex: '10000' });
			expect(document.querySelector('[data-modal-resize-key="marketplace-outro"]')).not.toBeNull();
		});

		it('names the agent that ran the playbook beside the title', () => {
			renderOutro();

			expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Alpha');
		});

		it('is titled with the playbook when the author gave no title', () => {
			const record = launchRecord();
			renderOutro({
				...record,
				spec: { ...record.spec, outro: { ...record.spec.outro, title: undefined } },
			});

			expect(screen.getByTestId('playbook-outro-modal')).toHaveAttribute(
				'aria-label',
				'Market Research'
			);
		});

		it('is for reading, so its text can be selected', () => {
			renderOutro();

			expect(screen.getByTestId('outro-summary')).toHaveClass('select-text');
			expect(screen.getByTestId('outro-status').closest('.select-none')).toBeNull();
			expect(screen.getByTestId('outro-status').closest('.select-text')).not.toBeNull();
		});

		it('has a visible way out and closes from it', () => {
			const { onClose } = renderOutro();

			fireEvent.click(screen.getByLabelText('Close modal'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('closes on Close', () => {
			const { onClose, onOpenFile } = renderOutro();

			fireEvent.click(screen.getByRole('button', { name: 'Close' }));

			expect(onClose).toHaveBeenCalledTimes(1);
			expect(onOpenFile).not.toHaveBeenCalled();
		});

		it('closes on Escape', async () => {
			const { onClose } = renderOutro();

			fireEvent.keyDown(window, { key: 'Escape' });

			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		});

		it('offers Close and Run again, in that order', () => {
			renderOutro();

			const labels = within(screen.getByTestId('playbook-outro-modal'))
				.getAllByRole('button')
				.map((button) => button.textContent);
			expect(labels.slice(-2)).toEqual(['Close', 'Run again']);
		});
	});

	describe('how the run ended', () => {
		it('says a finished run completed, and gives its numbers', () => {
			renderOutro();

			expect(screen.getByTestId('outro-status')).toHaveTextContent('Completed');
			expect(screen.getByTestId('outro-status')).toHaveAttribute('data-tone', 'success');
			expect(screen.getByTestId('outro-stat-tasks')).toHaveTextContent('Tasks');
			expect(screen.getByTestId('outro-stat-tasks')).toHaveTextContent('6 of 6');
			expect(screen.getByTestId('outro-stat-time')).toHaveTextContent('2m 5s');
			expect(screen.getByTestId('outro-stat-cost')).toHaveTextContent('$1.25');
		});

		it('says a stopped run kept its task documents so the person can resume', () => {
			renderOutro(stoppedRecord());

			expect(screen.getByTestId('outro-status')).toHaveTextContent(
				'Stopped. The task documents were kept so you can resume.'
			);
			expect(screen.getByTestId('outro-status')).toHaveAttribute('data-tone', 'warning');
			expect(screen.getByTestId('outro-stat-tasks')).toHaveTextContent('3 of 6');
			expect(screen.getByTestId('outro-stat-time')).toHaveTextContent('1m 1s');
			expect(screen.getByTestId('outro-stat-cost')).toHaveTextContent('$0.40');
		});

		it('leaves the cost out when the run did not report one', () => {
			renderOutro(
				launchRecord({
					completion: { completedTasks: 2, totalTasks: 2, elapsedTimeMs: 3_000, wasStopped: false },
				})
			);

			expect(screen.getByTestId('outro-stat-time')).toBeInTheDocument();
			expect(screen.queryByTestId('outro-stat-cost')).not.toBeInTheDocument();
		});

		it('shows no numbers for a launch that never recorded how its run ended', () => {
			renderOutro(launchRecord({ status: 'failed', completion: undefined, cleanup: undefined }));

			expect(screen.getByTestId('outro-status')).toHaveTextContent('The launch did not finish.');
			expect(screen.getByTestId('outro-status')).toHaveAttribute('data-tone', 'error');
			expect(screen.queryByTestId('outro-stats')).not.toBeInTheDocument();
		});
	});

	describe('the verdict', () => {
		it('shows the first heading section of the report file the run wrote', async () => {
			renderOutro();

			expect(await screen.findByTestId('outro-verdict')).toBeInTheDocument();
			expect(screen.getByTestId('outro-verdict-heading')).toHaveTextContent('Market Index');
			expect(markdownIn('outro-verdict-body')).toBe('VERDICT: the vault is complete.');
		});

		it('reads the report where the run wrote it: the path is filled from the launch', async () => {
			renderOutro();

			await screen.findByTestId('outro-verdict');
			expect(readFile).toHaveBeenCalledWith(INDEX_PATH, undefined);
		});

		it("reads the report on the agent's SSH remote when the agent ran on one", async () => {
			renderOutro(launchRecord({ sshRemoteId: 'remote-1' }));

			await screen.findByTestId('outro-verdict');
			expect(readFile).toHaveBeenCalledWith(INDEX_PATH, 'remote-1');
		});

		it('sits above the summary', async () => {
			renderOutro();

			const verdict = await screen.findByTestId('outro-verdict');
			const summary = screen.getByTestId('outro-summary');
			expect(
				Boolean(verdict.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
			).toBe(true);
		});

		it('draws the rest of the outro while the report is read, and without it when it is missing', async () => {
			readFile.mockResolvedValue(null);

			renderOutro();

			expect(screen.getByTestId('outro-summary')).toBeInTheDocument();
			await waitFor(() => expect(readFile).toHaveBeenCalled());
			expect(screen.queryByTestId('outro-verdict')).not.toBeInTheDocument();
			expect(screen.getByTestId('outro-next-steps')).toBeInTheDocument();
			expect(screen.getByTestId('outro-files')).toBeInTheDocument();
		});

		it('is left out when no heading in the report has text under it', async () => {
			readFile.mockResolvedValue('Just prose, no heading.');

			renderOutro();

			await waitFor(() => expect(readFile).toHaveBeenCalled());
			expect(screen.queryByTestId('outro-verdict')).not.toBeInTheDocument();
		});

		it('is not asked for when the playbook names no report file', async () => {
			const record = launchRecord();

			renderOutro({
				...record,
				spec: { ...record.spec, outro: { ...record.spec.outro, reportFile: undefined } },
			});

			expect(screen.queryByTestId('outro-verdict')).not.toBeInTheDocument();
			expect(readFile).not.toHaveBeenCalled();
		});

		it('is left out of a stopped run whose report was never written', async () => {
			readFile.mockResolvedValue(null);

			renderOutro(stoppedRecord());

			await waitFor(() => expect(readFile).toHaveBeenCalled());
			expect(screen.queryByTestId('outro-verdict')).not.toBeInTheDocument();
			expect(screen.getByTestId('outro-status')).toHaveTextContent('Stopped.');
		});
	});

	describe("the author's summary and next steps", () => {
		it('draws the summary with the answers and the agent filled in', () => {
			renderOutro();

			expect(markdownIn('outro-summary')).toBe('The vault on **Edge AI** was built by Alpha.');
		});

		it('draws the next steps as a bullet list', () => {
			renderOutro();

			expect(screen.getByText('What to do next')).toBeInTheDocument();
			expect(markdownIn('outro-next-steps')).toBe('- Start with `INDEX.md`.\n- Keep it current.');
		});

		it('draws no next steps section when the author lists none', () => {
			const record = launchRecord();
			renderOutro({
				...record,
				spec: { ...record.spec, outro: { ...record.spec.outro, nextSteps: [] } },
			});

			expect(screen.queryByTestId('outro-next-steps')).not.toBeInTheDocument();
			expect(screen.queryByText('What to do next')).not.toBeInTheDocument();
		});

		it("says what the launch's own copy of the block says, not what the manifest says now", () => {
			exchangeLists({
				id: 'research-market',
				launch: { inputs: [], outro: { summary: 'Rewritten since.', nextSteps: [] } },
			});

			renderOutro();

			expect(markdownIn('outro-summary')).toContain('The vault on');
			expect(markdownIn('outro-summary')).not.toContain('Rewritten since.');
		});
	});

	describe('the files', () => {
		it('offers one Open button per file, in the order the author listed them', () => {
			renderOutro();

			const rows = screen.getAllByTestId('outro-file');
			expect(rows).toHaveLength(2);
			expect(rows[0]).toHaveTextContent('Index');
			expect(rows[0]).toHaveTextContent(INDEX_PATH);
			expect(within(rows[0]).getByRole('button', { name: 'Open Index' })).toBeInTheDocument();
			expect(rows[1]).toHaveTextContent('Market map');
			expect(rows[1]).toHaveTextContent(MAP_PATH);
			expect(within(rows[1]).getByRole('button', { name: 'Open Market map' })).toBeInTheDocument();
		});

		it('draws no files section when the author names none', () => {
			const record = launchRecord();
			renderOutro({
				...record,
				spec: { ...record.spec, outro: { ...record.spec.outro, files: undefined } },
			});

			expect(screen.queryByTestId('outro-files')).not.toBeInTheDocument();
		});

		it('fills the date and the agent name into a file path, as the run named the file', () => {
			const record = launchRecord();
			renderOutro({
				...record,
				spec: {
					...record.spec,
					outro: {
						...record.spec.outro,
						files: [{ label: 'Log', path: '{{AUTORUN_FOLDER}}/LOG_{{AGENT_NAME}}_{{DATE}}.md' }],
					},
				},
			});

			expect(screen.getByTestId('outro-file')).toHaveTextContent(
				'/runs/docs/LOG_Alpha_2026-11-09.md'
			);
		});

		describe('Open', () => {
			it('closes the outro and opens the file, so the file is what the person sees next', () => {
				const { onClose, onOpenFile } = renderOutro();

				fireEvent.click(openButton('Market map'));

				expect(onOpenFile).toHaveBeenCalledTimes(1);
				expect(onOpenFile).toHaveBeenCalledWith(MAP_PATH);
				expect(onClose).toHaveBeenCalledTimes(1);
				expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
					onOpenFile.mock.invocationCallOrder[0]
				);
			});

			it('opens it on the agent that ran the playbook, even when the person is on another', () => {
				useSessionStore.setState({ activeSessionId: 'session-2' });
				const { onOpenFile } = renderOutro();
				let activeWhenOpened: string | undefined;
				onOpenFile.mockImplementation(() => {
					activeWhenOpened = useSessionStore.getState().activeSessionId;
				});

				fireEvent.click(openButton('Index'));

				expect(activeWhenOpened).toBe('session-1');
				expect(onOpenFile).toHaveBeenCalledWith(INDEX_PATH);
			});

			it('leaves the selection alone when the person is already on that agent', () => {
				const before = useSessionStore.getState().sessions;
				const { onOpenFile } = renderOutro();

				fireEvent.click(openButton('Index'));

				expect(onOpenFile).toHaveBeenCalledTimes(1);
				expect(useSessionStore.getState().activeSessionId).toBe('session-1');
				expect(useSessionStore.getState().sessions).toBe(before);
			});

			it('is off, with the reason, once the agent that ran the playbook is gone', () => {
				useSessionStore.setState({ sessions: [BETA], activeSessionId: 'session-2' });
				const { onClose, onOpenFile } = renderOutro();

				const button = openButton('Index');
				fireEvent.click(button);

				expect(button).toBeDisabled();
				expect(button).toHaveAttribute(
					'title',
					'The agent that ran this playbook no longer exists.'
				);
				expect(onOpenFile).not.toHaveBeenCalled();
				expect(onClose).not.toHaveBeenCalled();
			});

			it('goes off when the agent is deleted while the outro is up', () => {
				renderOutro();
				expect(openButton('Index')).toBeEnabled();

				act(() => useSessionStore.setState({ sessions: [BETA], activeSessionId: 'session-2' }));

				expect(openButton('Index')).toBeDisabled();
			});

			it('is off for a file the run did not write, and on for one it did', async () => {
				stat.mockImplementation(async (path: string) => (path === MAP_PATH ? null : STAT));

				renderOutro();

				await waitFor(() => expect(openButton('Market map')).toBeDisabled());
				expect(openButton('Market map')).toHaveAttribute(
					'title',
					'The run did not write this file.'
				);
				expect(openButton('Index')).toBeEnabled();
				expect(openButton('Index')).toHaveAttribute('title', `Open ${INDEX_PATH}`);
			});

			it('does nothing when a missing file is pressed', async () => {
				stat.mockResolvedValue(null);
				const { onClose, onOpenFile } = renderOutro();
				await waitFor(() => expect(openButton('Index')).toBeDisabled());

				fireEvent.click(openButton('Index'));

				expect(onOpenFile).not.toHaveBeenCalled();
				expect(onClose).not.toHaveBeenCalled();
			});

			it('stays on while the file is still being looked for', () => {
				stat.mockReturnValue(new Promise(() => undefined));

				renderOutro();

				expect(openButton('Index')).toBeEnabled();
			});

			it("looks for the file on the agent's SSH remote when the agent ran on one", async () => {
				renderOutro(launchRecord({ sshRemoteId: 'remote-1' }));

				await waitFor(() => expect(stat).toHaveBeenCalledWith(INDEX_PATH, 'remote-1'));
			});

			it('leaves a relative path to the open-file path, which resolves it against the agent project', async () => {
				const record = launchRecord();
				const { onOpenFile } = renderOutro({
					...record,
					spec: {
						...record.spec,
						outro: { ...record.spec.outro, files: [{ label: 'Notes', path: 'docs/NOTES.md' }] },
					},
				});

				expect(openButton('Notes')).toBeEnabled();
				expect(stat).not.toHaveBeenCalledWith('docs/NOTES.md', undefined);
				fireEvent.click(openButton('Notes'));
				expect(onOpenFile).toHaveBeenCalledWith('docs/NOTES.md');
			});
		});
	});

	describe('what cleanup did', () => {
		it('says the task documents were removed', () => {
			renderOutro();

			expect(screen.getByTestId('outro-cleanup')).toHaveTextContent(
				'Cleanup: the task documents were removed.'
			);
		});

		it('says cleanup was skipped for a stopped run, and where the documents are', () => {
			renderOutro(stoppedRecord());

			expect(screen.getByTestId('outro-cleanup')).toHaveTextContent(
				'Cleanup: skipped, because the run was stopped. The task documents are in "research-market-launch-20261109-090000".'
			);
		});

		it('says the documents were kept, and why', () => {
			renderOutro(launchRecord({ cleanup: 'kept', keepSavedPlaybook: true }));

			expect(screen.getByTestId('outro-cleanup')).toHaveTextContent(
				'kept in "research-market-launch-20261109-090000", because you saved this playbook to reuse.'
			);
		});

		it('marks a cleanup that failed as an error and gives the reason', () => {
			renderOutro(launchRecord({ cleanup: 'failed', cleanupError: 'EACCES: permission denied' }));

			expect(screen.getByTestId('outro-cleanup')).toHaveAttribute('data-tone', 'error');
			expect(screen.getByTestId('outro-cleanup')).toHaveTextContent('EACCES: permission denied');
		});

		it('says nothing before cleanup has run', () => {
			renderOutro(launchRecord({ cleanup: undefined }));

			expect(screen.queryByTestId('outro-cleanup')).not.toBeInTheDocument();
		});
	});

	describe('Run again', () => {
		const exchangePlaybook: Partial<MarketplacePlaybook> = {
			id: 'research-market',
			title: 'Market Research',
			author: 'Maestro Team',
			launch: {
				inputs: [{ name: 'MARKET_TOPIC', label: 'Topic', type: 'text', required: true }],
				outro: { summary: 'Done.', nextSteps: [] },
			},
		};

		function runAgain() {
			return screen.getByRole('button', { name: /^(Run again|Opening\.\.\.)$/ });
		}

		it('opens the launch dialog on the playbook with the answers the run used', async () => {
			exchangeLists(exchangePlaybook);
			renderOutro();

			fireEvent.click(runAgain());

			await waitFor(() => expect(useModalStore.getState().isOpen('playbookLaunch')).toBe(true));
			const data = useModalStore.getState().getData('playbookLaunch');
			expect(data?.playbook).toEqual(exchangePlaybook);
			expect(data?.initialValues).toEqual({ MARKET_TOPIC: 'Edge AI' });
		});

		it('closes the outro once the dialog is open, so the two never stack', async () => {
			exchangeLists(exchangePlaybook);
			const { onClose } = renderOutro();

			fireEvent.click(runAgain());

			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(useModalStore.getState().isOpen('playbookLaunch')).toBe(true);
		});

		it('hands the service the launch that ended', async () => {
			const record = launchRecord();
			reopenPlaybookLaunch.mockResolvedValueOnce(true);
			renderOutro(record);

			fireEvent.click(runAgain());

			await waitFor(() => expect(reopenPlaybookLaunch).toHaveBeenCalledWith(record));
		});

		it('launches nothing by itself: the person still presses Launch', async () => {
			exchangeLists(exchangePlaybook);
			renderOutro();

			fireEvent.click(runAgain());

			await waitFor(() => expect(useModalStore.getState().isOpen('playbookLaunch')).toBe(true));
			expect(window.maestro.marketplace.launch).not.toHaveBeenCalled();
		});

		it('says Opening... and is off while it looks the playbook up, and presses count once', async () => {
			let settle!: (opened: boolean) => void;
			reopenPlaybookLaunch.mockReturnValueOnce(
				new Promise<boolean>((resolve) => {
					settle = resolve;
				})
			);
			renderOutro();

			fireEvent.click(runAgain());
			fireEvent.click(runAgain());

			expect(runAgain()).toHaveTextContent('Opening...');
			expect(runAgain()).toBeDisabled();
			expect(reopenPlaybookLaunch).toHaveBeenCalledTimes(1);
			await act(async () => settle(false));
		});

		it('stays up, with the button back, when the dialog cannot be opened', async () => {
			let settle!: (opened: boolean) => void;
			reopenPlaybookLaunch.mockReturnValueOnce(
				new Promise<boolean>((resolve) => {
					settle = resolve;
				})
			);
			const { onClose } = renderOutro();
			fireEvent.click(runAgain());

			await act(async () => settle(false));

			expect(onClose).not.toHaveBeenCalled();
			expect(runAgain()).toHaveTextContent('Run again');
			expect(runAgain()).toBeEnabled();
			expect(screen.getByTestId('outro-summary')).toBeInTheDocument();
		});

		it('lets the person try again after a refusal', async () => {
			reopenPlaybookLaunch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			const { onClose } = renderOutro();

			fireEvent.click(runAgain());
			await waitFor(() => expect(runAgain()).toBeEnabled());
			fireEvent.click(runAgain());

			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(reopenPlaybookLaunch).toHaveBeenCalledTimes(2);
		});

		it('tells the person why, and stays up, when the playbook has left the Exchange', async () => {
			exchangeLists({ id: 'something-else' });
			const { onClose } = renderOutro();

			fireEvent.click(runAgain());

			await waitFor(() => expect(notifyToast).toHaveBeenCalledTimes(1));
			expect(notifyToast).toHaveBeenCalledWith({
				color: 'red',
				title: 'Cannot run again',
				message: '"Market Research" cannot be run again: it is no longer in the Playbook Exchange.',
			});
			expect(useModalStore.getState().isOpen('playbookLaunch')).toBe(false);
			expect(onClose).not.toHaveBeenCalled();
		});

		it('works for a stopped run too', async () => {
			exchangeLists(exchangePlaybook);
			renderOutro(stoppedRecord());

			fireEvent.click(runAgain());

			await waitFor(() => expect(useModalStore.getState().isOpen('playbookLaunch')).toBe(true));
		});
	});
});
