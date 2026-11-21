// Source: src/__tests__/renderer/components/QuickActionsModal/commands/computerHistoryCommand.test.ts
// Source: src/__tests__/renderer/components/QuickActionsModal/commands/reauthProviderCommand.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { buildFeatureCommands } from '../../../../../renderer/components/QuickActionsModal/commands/featureCommands';
import { beforeEach } from 'vitest';
import { buildSessionManagementCommands } from '../../../../../renderer/components/QuickActionsModal/commands/sessionCommands';
import { useAuthOutageStore } from '../../../../../renderer/stores/authOutageStore';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import type { QuickAction } from '../../../../../renderer/components/QuickActionsModal/types';
import type { Session } from '../../../../../renderer/types';
describeSourceSuite('computerHistoryCommand', () => {
	function build(onOpenComputerHistory?: () => void, close = vi.fn()) {
		return buildFeatureCommands({
			activeSession: undefined,
			onOpenComputerHistory,
			setQuickActionOpen: close,
			setSuccessFlashNotification: vi.fn(),
			setAgentSessionsOpen: vi.fn(),
			setActiveAgentSessionId: vi.fn(),
			bionifyReadingMode: false,
			setBionifyReadingMode: vi.fn(),
			audioFeedbackEnabled: false,
			setAudioFeedbackEnabled: vi.fn(),
			idleNotificationEnabled: false,
			setIdleNotificationEnabled: vi.fn(),
			showStarredSessionsSection: true,
			setShowStarredSessionsSection: vi.fn(),
			shortcuts: {
				computerHistory: {
					id: 'computerHistory',
					label: 'Computer History',
					keys: ['Control', 'Meta', 'h'],
				},
			},
		});
	}

	describe('Computer History palette entry', () => {
		it('is absent unless the caller can open the viewer (Encore off, or web-desktop)', () => {
			expect(build().map((a) => a.id)).not.toContain('computer-history');
		});

		it('opens the viewer, closes the palette, and shows its chord', () => {
			const open = vi.fn();
			const close = vi.fn();
			const entry = build(open, close).find((a) => a.id === 'computer-history')!;
			expect(entry.label).toBe('Computer History');
			expect(entry.shortcut?.keys).toEqual(['Control', 'Meta', 'h']);
			entry.action();
			expect(open).toHaveBeenCalled();
			expect(close).toHaveBeenCalledWith(false);
		});
	});
});
describeSourceSuite('reauthProviderCommand', () => {
	const setQuickActionOpen = vi.fn();

	function build(activeSession: Session | undefined): QuickAction[] {
		return buildSessionManagementCommands({
			activeSession,
			activeSessionId: activeSession?.id ?? '',
			sessions: activeSession ? [activeSession] : [],
			setSessions: vi.fn(),
			setQuickActionOpen,
			setRenameInstanceModalOpen: vi.fn(),
			setRenameInstanceValue: vi.fn(),
			deleteSession: vi.fn(),
			openClearBookmarksConfirm: vi.fn(),
		});
	}

	function find(commands: QuickAction[]): QuickAction | undefined {
		return commands.find((c) => c.id === 'reauthenticateProvider');
	}

	beforeEach(() => {
		vi.clearAllMocks();
		useAuthOutageStore.setState({ outages: {} });
		useModalStore.getState().closeModal('reauth');
		useSessionStore.setState({ sessions: [] } as never);
	});

	describe('Re-authenticate Provider command', () => {
		it('names the provider rather than the agent, because the login is shared', () => {
			const session = createMockSession({ id: 's1', name: 'Atlas', toolType: 'codex' });

			expect(find(build(session))?.label).toBe('Re-authenticate Provider: Codex');
		});

		// The Terminal agent is a plain shell: there is no login flow to run, and
		// offering one would open a dialog that can only sit there.
		it('is hidden for an agent with no login flow', () => {
			const terminal = createMockSession({ id: 's1', name: 'Shell', toolType: 'terminal' });

			expect(find(build(terminal))).toBeUndefined();
		});

		it('is hidden when there is no active agent', () => {
			expect(find(build(undefined))).toBeUndefined();
		});

		// The dialog is keyed to the provider, so it can only open once the outage
		// record exists for that key.
		it('opens the re-authentication dialog on the agent provider', async () => {
			const session = createMockSession({ id: 's1', name: 'Atlas', toolType: 'claude-code' });
			useSessionStore.setState({ sessions: [session] } as never);

			await find(build(session))!.action();

			expect(useModalStore.getState().getData('reauth')).toEqual({ providerKey: 'claude-code' });
			const outage = useAuthOutageStore.getState().outages['claude-code'];
			// Marked as the user's own login so the dialog does not claim the agent is
			// stopped, and carrying no lost turn to replay.
			expect(outage.initiatedBy).toBe('user');
			expect(outage.blocked).toEqual([{ sessionId: 's1', tabIds: [] }]);
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		// A remote agent authenticates on the remote host, so it must not be keyed to
		// (or resolved by) the local credential store.
		it('keys an SSH agent to its remote credential store', async () => {
			const session = createMockSession({
				id: 's1',
				name: 'Remote',
				toolType: 'claude-code',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			});
			useSessionStore.setState({ sessions: [session] } as never);

			await find(build(session))!.action();

			const providerKey = useModalStore.getState().getData('reauth')?.providerKey;
			expect(providerKey).not.toBe('claude-code');
			expect(useAuthOutageStore.getState().outages[providerKey!].sshRemoteId).toBe('remote-1');
		});
	});
});
