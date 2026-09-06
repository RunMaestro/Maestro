/**
 * Covers the CLI/web `refresh-auto-run` bridge in useAppRemoteEventListeners.
 *
 * This verb disturbs the user in TWO ways, and `--background` has to answer both:
 * it selects the target agent (that switch is how the non-background path gets a
 * non-active agent refreshed at all), and the refresh itself flashes "Found N new
 * documents" - a confirmation of an action the USER took, which is a lie when an
 * agent took it.
 *
 * The three branches are not symmetric, so each is pinned separately.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-tab-id' }));

/**
 * Mount the listeners with `activeSessionId` as the agent currently on screen.
 */
function setup(activeSessionId: string | null, sessions: Session[] = []) {
	vi.mocked(useSessionStore.getState).mockReturnValue({ activeSessionId } as never);

	const setActiveSessionId = vi.fn();
	const handleAutoRunRefresh = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: sessions },
			setActiveSessionId,
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh,
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as never)
	);

	return { setActiveSessionId, handleAutoRunRefresh };
}

function dispatchRefresh(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:refreshAutoRunDocs', { detail }));
}

describe('remote refresh-auto-run placement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('with no background flag (the existing behaviour)', () => {
		it('refreshes in place and flashes when the target is already on screen', () => {
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-1' });

			// undefined options means "not silent" - the flash is the point of a
			// user-initiated refresh.
			expect(handleAutoRunRefresh).toHaveBeenCalledWith(undefined);
			expect(setActiveSessionId).not.toHaveBeenCalled();
		});

		it('switches to the target when it is a different agent', () => {
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-2' });

			expect(setActiveSessionId).toHaveBeenCalledWith('agent-2');
			// The folder-path effect refreshes the newly active agent; this path
			// deliberately does not call the handler itself.
			expect(handleAutoRunRefresh).not.toHaveBeenCalled();
		});
	});

	describe('with --background', () => {
		it('refreshes the on-screen agent without flashing', () => {
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-1', background: true });

			expect(handleAutoRunRefresh).toHaveBeenCalledWith({ silent: true });
			expect(setActiveSessionId).not.toHaveBeenCalled();
		});

		it('moves nothing at all for an off-screen agent', () => {
			// Nothing on screen shows that agent's Auto Run list, and the loader
			// effect re-reads the folder when the user switches to it. Doing nothing
			// IS the refresh here - the alternative, switching, is exactly what
			// --background forbids.
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-2', background: true });

			expect(setActiveSessionId).not.toHaveBeenCalled();
			expect(handleAutoRunRefresh).not.toHaveBeenCalled();
		});
	});

	describe('background is an opt-in, not a default', () => {
		it.each([[undefined], [false], ['yes'], [1], [null]])(
			'still switches when background is %p',
			(value) => {
				// Anything looser than a literal `true` would silently stop the
				// web/mobile clients - which never send the field - from focusing.
				const { setActiveSessionId } = setup('agent-1');

				dispatchRefresh({ sessionId: 'agent-2', background: value });

				expect(setActiveSessionId).toHaveBeenCalledWith('agent-2');
			}
		);
	});

	it('does not confuse a session list entry for the active agent', () => {
		// The branch keys off the LIVE active id from the store, not off whether
		// the session exists. A refresh aimed at a known-but-unfocused agent is
		// still an off-screen refresh.
		const sessions = [createMockSession({ id: 'agent-2' })];
		const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1', sessions);

		dispatchRefresh({ sessionId: 'agent-2', background: true });

		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(handleAutoRunRefresh).not.toHaveBeenCalled();
	});
});
