/**
 * @file RunDetail.test.tsx
 * @description The Open PR action. A run reports its pull request URL as any
 * string, so the button opens only http(s) links in the system browser and
 * refuses anything else (a local path, a `file:` URL, another scheme) with a
 * toast. Without the check, a path reached `shell.openPath` and could launch a
 * program.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentRun } from '../../../../shared/agent-run';
import { RunDetail } from '../../../../renderer/components/AgentRunDashboard/RunDetail';
import { mockTheme } from '../../../helpers/mockTheme';

const { openInSystemBrowser, notifyToast } = vi.hoisted(() => ({
	openInSystemBrowser: vi.fn(),
	notifyToast: vi.fn(),
}));

vi.mock('../../../../renderer/utils/openUrl', () => ({ openInSystemBrowser }));

vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/stores/notificationStore')>()),
	notifyToast,
}));

function runWithPullRequest(url: string | undefined): AgentRun {
	return {
		id: 'run-alpha',
		createdAt: 1_704_067_200_000,
		updatedAt: 1_704_067_260_000,
		provider: 'claude-code',
		agentName: 'Alpha Engineer',
		prompt: 'Implement parser dashboard',
		status: 'completed',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		...(url === undefined ? {} : { pullRequest: { url } }),
	};
}

function clickOpenPr(url: string | undefined): void {
	render(
		<RunDetail
			theme={mockTheme}
			run={runWithPullRequest(url)}
			events={[]}
			onRefreshEvents={vi.fn()}
		/>
	);
	fireEvent.click(screen.getByRole('button', { name: 'Open PR' }));
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('RunDetail Open PR', () => {
	it.each(['https://github.com/acme/app/pull/42', 'http://git.internal/acme/app/pull/42'])(
		'opens %s in the system browser',
		(url) => {
			clickOpenPr(url);

			expect(openInSystemBrowser).toHaveBeenCalledWith(url);
			expect(notifyToast).not.toHaveBeenCalled();
		}
	);

	it.each([
		'/Applications/Calculator.app',
		'file:///Applications/Calculator.app',
		'FILE:///Users/me/Downloads/Setup.pkg',
		'C:\\Users\\me\\Downloads\\setup.exe',
		'javascript:alert(1)',
		'smb://fileserver/share/setup.exe',
		'maestro+file:///Applications/Calculator.app',
		'github.com/acme/app/pull/42',
	])('refuses %s with a toast and opens nothing', (url) => {
		clickOpenPr(url);

		expect(openInSystemBrowser).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledTimes(1);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'red',
				title: 'Cannot open the pull request',
				message: expect.stringContaining(url),
			})
		);
	});

	it('keeps the button disabled when the run has no pull request', () => {
		render(
			<RunDetail
				theme={mockTheme}
				run={runWithPullRequest(undefined)}
				events={[]}
				onRefreshEvents={vi.fn()}
			/>
		);

		expect(screen.getByRole('button', { name: 'Open PR' })).toBeDisabled();
	});
});
