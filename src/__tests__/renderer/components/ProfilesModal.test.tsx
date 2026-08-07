/**
 * @file ProfilesModal.test.tsx
 * @description Smoke and refresh tests for the Agent Profiles modal (Phase 6):
 * it renders the stored profiles with dialog semantics, refetches on the
 * `profiles:changed` push the main process sends after every profiles.yaml
 * write, and still refetches on the manual refresh button.
 */

import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfilesModal } from '../../../renderer/components/ProfilesModal/ProfilesModal';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import type { AgentProfile } from '../../../shared/profiles/types';

// The layer stack is exercised elsewhere; here it is a no-op so the modal can
// render without a LayerStackProvider.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

const PROJECT_ROOT = '/test/project';

let profilesApi: {
	list: ReturnType<typeof vi.fn>;
	upsert: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	onProfilesChanged: ReturnType<typeof vi.fn>;
};

/** Captured `profiles:changed` subscribers. */
let profilesChangedListeners: Array<(payload: { projectRoot: string }) => void>;
let unsubscribeProfilesChanged: ReturnType<typeof vi.fn>;

function emitProfilesChanged(projectRoot = PROJECT_ROOT): void {
	for (const listener of profilesChangedListeners) listener({ projectRoot });
}

function installApi(initial: AgentProfile[]): void {
	profilesChangedListeners = [];
	unsubscribeProfilesChanged = vi.fn();
	profilesApi = {
		list: vi.fn().mockResolvedValue(initial),
		upsert: vi.fn(),
		delete: vi.fn(),
		onProfilesChanged: vi.fn((cb: (payload: { projectRoot: string }) => void) => {
			profilesChangedListeners.push(cb);
			return unsubscribeProfilesChanged;
		}),
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window.maestro as any).profiles = profilesApi;
}

beforeEach(() => {
	useSessionStore.setState({
		sessions: [createMockSession({ id: 's1', projectRoot: PROJECT_ROOT })],
		activeSessionId: 's1',
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('ProfilesModal', () => {
	it('renders the stored profiles inside a labelled dialog', async () => {
		installApi([{ id: 'p1', name: 'Reviewer', baseAgentId: 's1', model: 'sonnet' }]);

		render(<ProfilesModal theme={mockTheme} onClose={vi.fn()} />);

		expect(await screen.findByText('Reviewer')).toBeInTheDocument();
		const dialog = screen.getByRole('dialog');
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveAccessibleName('Agent Profiles');
	});

	it('refetches on a profiles:changed push and unsubscribes on unmount', async () => {
		installApi([]);

		const { unmount } = render(<ProfilesModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(profilesApi.list).toHaveBeenCalledTimes(1));
		expect(profilesApi.onProfilesChanged).toHaveBeenCalled();

		// A push for another project is ignored; one for this project refetches.
		emitProfilesChanged('/some/other/project');
		expect(profilesApi.list).toHaveBeenCalledTimes(1);

		profilesApi.list.mockResolvedValue([{ id: 'p2', name: 'Implementer' }]);
		emitProfilesChanged();
		expect(await screen.findByText('Implementer')).toBeInTheDocument();

		unmount();
		expect(unsubscribeProfilesChanged).toHaveBeenCalled();
	});

	it('refetches when the refresh button is pressed', async () => {
		installApi([]);

		render(<ProfilesModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(profilesApi.list).toHaveBeenCalledTimes(1));

		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		await waitFor(() => expect(profilesApi.list).toHaveBeenCalledTimes(2));
	});
});
