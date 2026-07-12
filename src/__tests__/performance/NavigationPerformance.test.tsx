import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollapsedSessionPillRows } from '../../renderer/components/SessionList/CollapsedSessionPill';
import type { Session } from '../../renderer/types';
import { createMockTheme } from '../helpers/mockTheme';

function makeSession(index: number): Session {
	return {
		id: `session-${index}`,
		name: `Session ${index}`,
		toolType: 'codex',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
	} as Session;
}

describe('NavigationPerformance', () => {
	it('keeps a 70-session collapsed sidebar inside its idle DOM budget', () => {
		const sessions = Array.from({ length: 70 }, (_, index) => makeSession(index));
		const getFileCount = vi.fn(() => 0);
		const startedAt = performance.now();
		const { container } = render(
			<CollapsedSessionPillRows
				sessions={sessions}
				keyPrefix="navigation-benchmark"
				onContainerClick={vi.fn()}
				theme={createMockTheme()}
				activeBatchSessionIds={[]}
				leftSidebarWidth={440}
				contextWarningYellowThreshold={70}
				contextWarningRedThreshold={90}
				getFileCount={getFileCount}
				getWorktreeChildren={() => []}
				setActiveSessionId={vi.fn()}
			/>
		);
		const elapsed = performance.now() - startedAt;

		expect(container.querySelectorAll('[data-testid="collapsed-session-tooltip"]')).toHaveLength(0);
		expect(container.querySelectorAll('*').length).toBeLessThan(400);
		expect(getFileCount).not.toHaveBeenCalled();
		expect(elapsed).toBeLessThan(250);
	});
});
