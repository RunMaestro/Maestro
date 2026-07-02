import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Theme } from '../../../renderer/types';

// The consulted-agent roster the header checks before jumping. Mutable so a
// test can simulate the target agent having been deleted since it answered.
let mockSessions: Array<{ id: string; name: string; toolType: string }> = [];
vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: { getState: () => ({ sessions: mockSessions }) },
}));
vi.mock('../../../renderer/utils/openMaestroLink', () => ({
	openMaestroLink: vi.fn(),
}));
vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn(async () => true),
}));
vi.mock('../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

import { CrossAgentResponseHeader } from '../../../renderer/components/CrossAgentResponseHeader';
import { openMaestroLink } from '../../../renderer/utils/openMaestroLink';
import { safeClipboardWrite } from '../../../renderer/utils/clipboard';
import { flashCopiedToClipboard } from '../../../renderer/utils/flashCopiedToClipboard';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';

const SESSION_ID = '604d5b6a-14a6-45e8-b146-20480f78a823';

function makeTheme(): Theme {
	return {
		id: 'dracula',
		name: 'Test',
		mode: 'dark',
		colors: {
			bgMain: '#111111',
			bgSidebar: '#0a0a0a',
			bgActivity: '#161616',
			border: '#333333',
			textMain: '#eeeeee',
			textDim: '#888888',
			accent: '#7c3aed',
			accentDim: '#5b21b6',
			accentText: '#c4b5fd',
			accentForeground: '#ffffff',
			success: '#22c55e',
			warning: '#eab308',
			error: '#ef4444',
		},
	} as Theme;
}

function makeMeta(overrides: Record<string, unknown> = {}) {
	return {
		requestId: 'req-1',
		fromSessionId: SESSION_ID,
		fromAgentName: 'Maestro Marketing',
		fromToolType: 'claude-code',
		...overrides,
	} as any;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockSessions = [{ id: SESSION_ID, name: 'Maestro Marketing', toolType: 'claude-code' }];
});

describe('CrossAgentResponseHeader', () => {
	it('shows the agent name, provider, and a short session id', () => {
		render(<CrossAgentResponseHeader crossAgent={makeMeta()} theme={makeTheme()} />);
		expect(screen.getByText('Maestro Marketing')).toBeTruthy();
		expect(screen.getByText('Claude Code')).toBeTruthy(); // provider display name
		expect(screen.getByText('604d5b6a')).toBeTruthy(); // first UUID segment
	});

	it('jumps to the consulted agent when the name is clicked', () => {
		render(<CrossAgentResponseHeader crossAgent={makeMeta()} theme={makeTheme()} />);
		fireEvent.click(screen.getByText('Maestro Marketing'));
		expect(openMaestroLink).toHaveBeenCalledWith(`maestro://session/${SESSION_ID}`);
	});

	it('jumps via the explicit jump button too', () => {
		render(<CrossAgentResponseHeader crossAgent={makeMeta()} theme={makeTheme()} />);
		fireEvent.click(screen.getByLabelText('Jump to Maestro Marketing'));
		expect(openMaestroLink).toHaveBeenCalledWith(`maestro://session/${SESSION_ID}`);
	});

	it('deep-links to the consult tab when the entry carries a fromTabId', () => {
		// The persisted answer lives in a consult tab on the target; the jump must
		// land there rather than on whatever tab was last active.
		render(
			<CrossAgentResponseHeader
				crossAgent={makeMeta({ fromTabId: 'consult-tab-1' })}
				theme={makeTheme()}
			/>
		);
		fireEvent.click(screen.getByText('Maestro Marketing'));
		expect(openMaestroLink).toHaveBeenCalledWith(
			`maestro://session/${SESSION_ID}/tab/consult-tab-1`
		);
	});

	it('flashes and does NOT jump when the consulted agent no longer exists', () => {
		mockSessions = []; // agent was deleted since it answered
		render(<CrossAgentResponseHeader crossAgent={makeMeta()} theme={makeTheme()} />);
		fireEvent.click(screen.getByText('Maestro Marketing'));
		expect(openMaestroLink).not.toHaveBeenCalled();
		expect(notifyCenterFlash).toHaveBeenCalledWith(expect.objectContaining({ color: 'orange' }));
	});

	it('copies the full session id when the id chip is clicked', async () => {
		render(<CrossAgentResponseHeader crossAgent={makeMeta()} theme={makeTheme()} />);
		fireEvent.click(screen.getByText('604d5b6a'));
		expect(safeClipboardWrite).toHaveBeenCalledWith(SESSION_ID);
		await waitFor(() => expect(flashCopiedToClipboard).toHaveBeenCalled());
	});

	it('shows a spinner while the reply is still streaming', () => {
		const { container } = render(
			<CrossAgentResponseHeader crossAgent={makeMeta({ streaming: true })} theme={makeTheme()} />
		);
		expect(container.querySelector('.animate-spin')).not.toBeNull();
	});

	it('surfaces the failure text on an errored consult', () => {
		render(
			<CrossAgentResponseHeader crossAgent={makeMeta({ error: 'boom' })} theme={makeTheme()} />
		);
		expect(screen.getByText('Consulted agent could not respond: boom')).toBeTruthy();
	});
});
