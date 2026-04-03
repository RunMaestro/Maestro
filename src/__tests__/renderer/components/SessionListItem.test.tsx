import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionListItem } from '../../../renderer/components/SessionListItem';
import type { Theme } from '../../../renderer/types';
import type { AgentSession } from '../../../renderer/hooks/agent/useSessionViewer';
import { createOpenClawAgentSession } from '../../fixtures/openclaw';

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

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		...createOpenClawAgentSession({
			sessionId: 'session-1234-uuid',
			projectPath: '/tmp/project',
			firstMessage: 'First message',
		}),
		...overrides,
	};
}

describe('SessionListItem', () => {
	it('labels CLI-origin OpenClaw sessions correctly and shortens composite IDs', () => {
		render(
			<SessionListItem
				session={makeSession({
					sessionId: 'main:1234abcd-uuid',
					origin: undefined,
				})}
				agentId="openclaw"
				index={0}
				selectedIndex={0}
				isStarred={false}
				activeAgentSessionId={null}
				renamingSessionId={null}
				renameValue=""
				searchMode="all"
				searchResultInfo={null}
				theme={theme}
				selectedItemRef={createRef()}
				renameInputRef={createRef()}
				onSessionClick={vi.fn()}
				onToggleStar={vi.fn()}
				onQuickResume={vi.fn()}
				onStartRename={vi.fn()}
				onRenameChange={vi.fn()}
				onSubmitRename={vi.fn()}
				onCancelRename={vi.fn()}
			/>
		);

		expect(screen.getByTitle('OpenClaw CLI session')).toBeInTheDocument();
		expect(screen.getByText('MAIN')).toBeInTheDocument();
	});
});
