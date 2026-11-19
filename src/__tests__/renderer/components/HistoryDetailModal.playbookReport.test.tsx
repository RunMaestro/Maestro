/**
 * HistoryDetailModal with a playbook run's summary entry: the report is drawn
 * with the same sections as the completion modal (the shared
 * PlaybookReportBody), the failure card sits above the narrative, the classic
 * Auto Run summary stays below it, and report paths resolve against the run's
 * own folder.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryDetailModal } from '../../../renderer/components/HistoryDetailModal';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { HistoryEntry } from '../../../renderer/types';
import {
	buildFinalSummaryFacts,
	renderPlaybookReportMarkdown,
	type PlaybookRunReport,
	type PlaybookRunReportStatus,
} from '../../../shared/playbookRunReport';
import { mockTheme } from '../../helpers/mockTheme';

type MarkdownProps = {
	content: string;
	cwd?: string;
	onFileClick?: (path: string) => void;
};
const markdownProps: MarkdownProps[] = [];
vi.mock('../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: (props: MarkdownProps) => {
		markdownProps.push(props);
		return <div data-testid="markdown-renderer">{props.content}</div>;
	},
}));

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-id-1'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

const SUMMARY_BLOCK = '**Auto Run Summary**\n- **Status:** Completed with 1 stalled document(s)';

function makeReport(
	status: PlaybookRunReportStatus,
	overrides: Partial<PlaybookRunReport> = {}
): PlaybookRunReport {
	return {
		playbookName: 'Release Pipeline',
		status,
		facts: buildFinalSummaryFacts({
			wasStopped: false,
			totalCompletedTasks: 3,
			totalElapsedMs: 65_000,
			stalledDocuments:
				status === 'partial' ? new Map([['02-BUILD.md', 'No progress']]) : new Map(),
			documents: [{ filename: '01-SETUP.md' }, { filename: '02-BUILD.md' }],
			loopEnabled: false,
			loopIteration: 0,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			totalCost: 0.02,
		}),
		narrative: {
			version: 1,
			sections: [
				{ kind: 'accomplishments', title: 'Accomplishments', items: [{ text: 'Shipped it' }] },
			],
		},
		howToUse: 'Run `npm start`.',
		evidence: { source: 'git', changedFiles: ['src/a.ts'], createdFiles: [], deletedFiles: [] },
		parameters: [],
		startedAt: 0,
		finishedAt: 65_000,
		cwd: '/worktrees/release',
		...overrides,
	};
}

function makeEntry(report: PlaybookRunReport, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: 'entry-1',
		timestamp: 0,
		type: 'AUTO',
		summary: 'Auto Run completed with stalls: 3 tasks in 1m 5s (1 stalled)',
		fullResponse: `${renderPlaybookReportMarkdown(report).trimEnd()}\n\n${SUMMARY_BLOCK}`,
		playbookReport: report,
		projectPath: '/project',
		sessionId: 'agent-1',
		...overrides,
	};
}

describe('HistoryDetailModal with a playbook run report', () => {
	beforeEach(() => {
		markdownProps.length = 0;
		useSettingsStore.setState({ bionifyReadingMode: false });
	});

	it('draws the report sections, failure card first, then the Auto Run summary', () => {
		const report = makeReport('partial', {
			problems: [{ kind: 'stall', document: '02-BUILD.md', taskIndex: 1, message: 'No progress' }],
		});
		render(<HistoryDetailModal theme={mockTheme} entry={makeEntry(report)} onClose={vi.fn()} />);

		expect(screen.getByTestId('playbook-report-status')).toHaveTextContent('Partially completed');

		const card = screen.getByTestId('playbook-report-not-done');
		const main = screen.getByTestId('playbook-report-main');
		expect(card).toHaveTextContent('task 2 of `02-BUILD.md`: No progress');
		expect(main).toHaveTextContent('## What was done');
		expect(main).toHaveTextContent('## How to use it');
		expect(card.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		expect(screen.getByTestId('playbook-report-details')).toHaveTextContent('## Files changed');

		// The rest of the entry's text, without a second copy of the report.
		const summary = screen.getByTestId('history-detail-run-summary');
		expect(summary).toHaveTextContent('**Auto Run Summary**');
		expect(summary).not.toHaveTextContent('## What was done');
		expect(main.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('has no failure card for a completed run', () => {
		render(
			<HistoryDetailModal
				theme={mockTheme}
				entry={makeEntry(makeReport('completed'))}
				onClose={vi.fn()}
			/>
		);
		expect(screen.getByTestId('playbook-report-status')).toHaveTextContent('Completed');
		expect(screen.queryByTestId('playbook-report-not-done')).toBeNull();
	});

	it("resolves the report's relative paths against the run's folder", () => {
		const onFileClick = vi.fn();
		render(
			<HistoryDetailModal
				theme={mockTheme}
				entry={makeEntry(makeReport('completed'))}
				onClose={vi.fn()}
				cwd="/project"
				onFileClick={onFileClick}
			/>
		);
		const reportProps = markdownProps.find((p) => p.content.startsWith('## What was done'))!;
		expect(reportProps.cwd).toBe('/worktrees/release');
		reportProps.onFileClick!('src/a.ts');
		expect(onFileClick).toHaveBeenLastCalledWith('/worktrees/release/src/a.ts');
		reportProps.onFileClick!('/abs/file.md');
		expect(onFileClick).toHaveBeenLastCalledWith('/abs/file.md');
	});

	it('renders an entry without a report as plain markdown', () => {
		render(
			<HistoryDetailModal
				theme={mockTheme}
				entry={{
					id: 'e',
					timestamp: 0,
					type: 'AUTO',
					summary: 's',
					fullResponse: SUMMARY_BLOCK,
					projectPath: '/project',
				}}
				onClose={vi.fn()}
			/>
		);
		expect(screen.queryByTestId('playbook-report-body')).toBeNull();
		expect(markdownProps.at(-1)!.content).toBe(SUMMARY_BLOCK);
	});
});
