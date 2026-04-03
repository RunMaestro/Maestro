import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionTooltipContent } from '../../../../renderer/components/SessionList/SessionTooltipContent';
import type { Session, Theme } from '../../../../renderer/types';

const theme: Theme = {
	name: 'test',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1a1a1a',
		bgInput: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#44aaff',
		border: '#444444',
		success: '#22cc66',
		error: '#ff5555',
		warning: '#ffaa33',
	},
} as Theme;

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'OpenClaw Remote Session',
		type: 'agent',
		toolType: 'openclaw',
		state: 'ready',
		cwd: '/tmp/project',
		projectRoot: '/tmp/project',
		contextUsage: 42,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

describe('SessionTooltipContent', () => {
	it('shows SSH remote badges when only sshRemoteId is present on a git-backed session', () => {
		render(
			<SessionTooltipContent
				session={makeSession({
					sshRemoteId: 'ssh-remote-1',
					isGitRepo: true,
				})}
				theme={theme}
				gitFileCount={3}
			/>
		);

		expect(screen.getByTitle('Remote SSH')).toBeInTheDocument();
		expect(screen.getByText('GIT')).toBeInTheDocument();
		expect(screen.getByText('ready • OpenClaw (SSH)')).toBeInTheDocument();
	});
});
