import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	loadLatestPlaybookRunReport,
	loadPlaybookReportPrompt,
	savePlaybookReportToProject,
	savePlaybookRunReport,
} from '../../../renderer/services/playbookRunReport';
import { buildFinalSummaryFacts, type PlaybookRunReport } from '../../../shared/playbookRunReport';
import { fileTimestampSlug } from '../../../shared/formatters';

const finishedAt = new Date(2026, 10, 19, 9, 30, 0).getTime();
const stamp = fileTimestampSlug(finishedAt);

function makeReport(overrides: Partial<PlaybookRunReport> = {}): PlaybookRunReport {
	return {
		playbookName: 'Message Bus',
		playbookId: 'pb-1',
		status: 'completed',
		facts: buildFinalSummaryFacts({
			wasStopped: false,
			totalCompletedTasks: 2,
			totalElapsedMs: 5_000,
			stalledDocuments: new Map(),
			documents: [{ filename: 'bus/one' }],
			loopEnabled: false,
			loopIteration: 0,
			totalInputTokens: 10,
			totalOutputTokens: 20,
			totalCost: 0.01,
		}),
		parameters: [],
		startedAt: finishedAt - 5_000,
		finishedAt,
		...overrides,
	};
}

function fsApi() {
	return window.maestro.fs as unknown as {
		mkdir: ReturnType<typeof vi.fn>;
		writeFile: ReturnType<typeof vi.fn>;
		readDir: ReturnType<typeof vi.fn>;
		readFile: ReturnType<typeof vi.fn>;
	};
}

function promptsApi() {
	return window.maestro.prompts as unknown as { get: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
	vi.clearAllMocks();
	fsApi().mkdir.mockResolvedValue({ success: true });
	fsApi().writeFile.mockResolvedValue({ success: true });
});

describe('savePlaybookRunReport', () => {
	it('writes the markdown and the JSON under .maestro-reports/ and returns both paths', async () => {
		const saved = await savePlaybookRunReport(makeReport(), '/project/Auto Run Docs');

		const markdownPath = `/project/Auto Run Docs/.maestro-reports/message-bus-${stamp}.md`;
		const jsonPath = `/project/Auto Run Docs/.maestro-reports/message-bus-${stamp}.json`;
		expect(saved).toEqual({ markdownPath, jsonPath });
		expect(fsApi().mkdir).toHaveBeenCalledWith(
			'/project/Auto Run Docs/.maestro-reports',
			undefined
		);

		const [mdCall, jsonCall] = fsApi().writeFile.mock.calls;
		expect(mdCall[0]).toBe(markdownPath);
		expect(mdCall[1]).toMatch(/^# Message Bus\n/);
		expect(jsonCall[0]).toBe(jsonPath);
		const written = JSON.parse(jsonCall[1]) as PlaybookRunReport;
		expect(written.reportPath).toBe(markdownPath);
		expect(written.facts.totalCompletedTasks).toBe(2);
	});

	it('writes on the SSH remote when the agent has one', async () => {
		await savePlaybookRunReport(makeReport(), '/home/me/docs', 'remote-1');

		expect(fsApi().mkdir).toHaveBeenCalledWith('/home/me/docs/.maestro-reports', 'remote-1');
		for (const call of fsApi().writeFile.mock.calls) {
			expect(call[2]).toBe('remote-1');
		}
	});

	it('keeps a Windows folder on backslashes', async () => {
		const saved = await savePlaybookRunReport(makeReport(), 'C:\\work\\docs');
		expect(saved?.markdownPath).toBe(`C:\\work\\docs\\.maestro-reports\\message-bus-${stamp}.md`);
	});

	it('answers null when a write fails or rejects, never throwing', async () => {
		fsApi().writeFile.mockResolvedValueOnce({ success: false });
		await expect(savePlaybookRunReport(makeReport(), '/docs')).resolves.toBeNull();

		fsApi().mkdir.mockRejectedValueOnce(new Error('EACCES'));
		await expect(savePlaybookRunReport(makeReport(), '/docs')).resolves.toBeNull();
	});
});

describe('loadPlaybookReportPrompt', () => {
	it('returns the prompt content', async () => {
		promptsApi().get.mockResolvedValueOnce({ success: true, content: 'Write the report.' });
		await expect(loadPlaybookReportPrompt('playbook-report-document')).resolves.toBe(
			'Write the report.'
		);
		expect(promptsApi().get).toHaveBeenCalledWith('playbook-report-document');
	});

	it('throws on a failed or empty load', async () => {
		promptsApi().get.mockResolvedValueOnce({ success: false, error: 'missing' });
		await expect(loadPlaybookReportPrompt('playbook-report-synthesis')).rejects.toThrow(/missing/);
		promptsApi().get.mockResolvedValueOnce({ success: true, content: '  ' });
		await expect(loadPlaybookReportPrompt('playbook-report-synthesis')).rejects.toThrow();
	});
});

describe('savePlaybookReportToProject', () => {
	const savedAt = new Date(2026, 10, 19, 14, 3, 7).getTime();

	it('writes the rendered report to <cwd>/<slug>-REPORT-<timestamp>.md and returns the path', async () => {
		const path = await savePlaybookReportToProject(makeReport(), '/project', undefined, savedAt);

		expect(path).toBe('/project/message-bus-REPORT-20261119-140307.md');
		const [call] = fsApi().writeFile.mock.calls;
		expect(call[0]).toBe(path);
		expect(call[1]).toMatch(/^# Message Bus\n/);
		expect(call[2]).toBeUndefined();
	});

	it('writes on the SSH remote when the agent has one', async () => {
		await savePlaybookReportToProject(makeReport(), '/home/me/app', 'remote-1', savedAt);
		expect(fsApi().writeFile.mock.calls[0][2]).toBe('remote-1');
	});

	it('throws when the write fails, so the caller can say so', async () => {
		fsApi().writeFile.mockResolvedValueOnce({ success: false });
		await expect(
			savePlaybookReportToProject(makeReport(), '/project', undefined, savedAt)
		).rejects.toThrow('/project/message-bus-REPORT-20261119-140307.md');
	});
});

describe('loadLatestPlaybookRunReport', () => {
	const file = (name: string) => ({ name, isFile: true, isDirectory: false, path: name });

	it('reads the newest saved report from .maestro-reports/', async () => {
		fsApi().readDir.mockResolvedValueOnce([
			file('old-20261101-090000.json'),
			file('new-20261119-090000.json'),
			file('new-20261119-090000.md'),
		]);
		fsApi().readFile.mockResolvedValueOnce(JSON.stringify(makeReport()));

		const report = await loadLatestPlaybookRunReport('/docs', 'remote-1');

		expect(fsApi().readDir).toHaveBeenCalledWith('/docs/.maestro-reports', 'remote-1');
		expect(fsApi().readFile).toHaveBeenCalledWith(
			'/docs/.maestro-reports/new-20261119-090000.json',
			'remote-1'
		);
		expect(report?.playbookName).toBe('Message Bus');
	});

	it('answers null with no folder, no report, or an unreadable one', async () => {
		fsApi().readDir.mockRejectedValueOnce(new Error('ENOENT'));
		await expect(loadLatestPlaybookRunReport('/docs')).resolves.toBeNull();

		fsApi().readDir.mockResolvedValueOnce([file('notes.md')]);
		await expect(loadLatestPlaybookRunReport('/docs')).resolves.toBeNull();

		fsApi().readDir.mockResolvedValueOnce([file('x-20261119-090000.json')]);
		fsApi().readFile.mockResolvedValueOnce('{"not":"a report"}');
		await expect(loadLatestPlaybookRunReport('/docs')).resolves.toBeNull();
	});
});
