/**
 * The command palette is how a feature gets found by someone who does not know
 * its hotkey, so A Cappella has to be reachable from it - and reachable by the
 * word a user would actually type, which is "voice", not "A Cappella".
 *
 * The load-bearing case is the Encore gate: an install that never turned the
 * feature on must have no voice entries at all, rather than entries that fail.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildVoiceCommands } from '../../../../../renderer/components/QuickActionsModal/commands/voiceCommands';
import { filterAndSortQuickActions } from '../../../../../renderer/components/QuickActionsModal/utils/quickActionSorting';
import type { VoiceAgentActions } from '../../../../../renderer/hooks/voice/useVoiceAgentActions';
import type { Session } from '../../../../../renderer/types';

function voiceActions(overrides: Partial<VoiceAgentActions> = {}): VoiceAgentActions {
	return {
		enabled: true,
		hasVoiceFloor: false,
		isSpeaking: false,
		wakePhrase: null,
		talkToAgent: vi.fn().mockResolvedValue(undefined),
		talkToConductor: vi.fn().mockResolvedValue(undefined),
		endVoiceSession: vi.fn().mockResolvedValue(undefined),
		showHud: vi.fn(),
		hudHidden: false,
		...overrides,
	};
}

function harness(
	overrides: Partial<VoiceAgentActions> = {},
	// `noActiveSession` rather than an optional session: an `activeSession?` field
	// cannot express "deliberately none" once the harness supplies a default.
	options: { noActiveSession?: boolean } = {}
) {
	const actions = voiceActions(overrides);
	const setQuickActionOpen = vi.fn();
	const toggleTranscript = vi.fn().mockResolvedValue(undefined);
	const commands = buildVoiceCommands({
		activeSession: options.noActiveSession ? undefined : ({ id: 'a1', name: 'Backend' } as Session),
		voiceActions: actions,
		transcriptVisible: false,
		toggleTranscript,
		setQuickActionOpen,
	});
	return { commands, actions, setQuickActionOpen, toggleTranscript };
}

const idsOf = (commands: ReturnType<typeof harness>['commands']) => commands.map((c) => c.id);

describe('buildVoiceCommands', () => {
	it('offers nothing at all when the Encore Feature is off', () => {
		expect(harness({ enabled: false }).commands).toEqual([]);
	});

	it('offers the conductor and the active agent', () => {
		expect(idsOf(harness().commands)).toEqual(
			expect.arrayContaining(['voiceTalkToAgent', 'voiceTalkToConductor'])
		);
	});

	it('drops the per-agent entry when no agent is active', () => {
		const { commands } = harness({}, { noActiveSession: true });
		expect(idsOf(commands)).not.toContain('voiceTalkToAgent');
		expect(idsOf(commands)).toContain('voiceTalkToConductor');
	});

	it('starts the conductor through the shared action, which un-hides the HUD', () => {
		// Not `window.maestro.voice.start()` directly: that was how asking for the
		// conductor from the palette opened a microphone behind a minimized HUD.
		const { commands, actions, setQuickActionOpen } = harness();
		commands.find((c) => c.id === 'voiceTalkToConductor')!.action();

		expect(actions.talkToConductor).toHaveBeenCalledOnce();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('teaches the wake phrase on the agent entry when there is one', () => {
		const { commands } = harness({ wakePhrase: 'hey backend' });
		const talk = commands.find((c) => c.id === 'voiceTalkToAgent');
		expect(talk?.subtext).toContain('hey backend');
	});

	it('hides the restore entry while the HUD is on screen', () => {
		expect(idsOf(harness().commands)).not.toContain('voiceShowHud');
	});

	it('offers to restore a minimized HUD, and does it', () => {
		const { commands, actions, setQuickActionOpen } = harness({ hudHidden: true });
		const show = commands.find((c) => c.id === 'voiceShowHud');

		expect(show).toBeTruthy();
		show!.action();
		expect(actions.showHud).toHaveBeenCalledOnce();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('offers to end a session only while one is running', () => {
		expect(idsOf(harness().commands)).not.toContain('voiceEndSession');
		expect(idsOf(harness({ hasVoiceFloor: true }).commands)).toContain('voiceEndSession');
	});

	// Through the real filter, not an approximation of it: palette search reads
	// LABELS, so "Talk to Backend" was invisible to someone typing "voice" - the
	// palette's only voice hit was the transcript toggle, which cannot start
	// anything. These pin the entries to the words a user actually types.
	describe('discoverability', () => {
		const everyCommand = () => harness({ hudHidden: true, hasVoiceFloor: true }).commands;
		const search = (term: string) =>
			filterAndSortQuickActions(everyCommand(), term, 'main').map((c) => c.id);

		it.each(['voice', 'acappella', 'a cappella', 'mic'])(
			'surfaces a way to START talking when searching "%s"',
			(term) => {
				// Not just "returns something": an entry that only toggles a transcript
				// is exactly the dead end this replaced.
				expect(search(term)).toEqual(
					expect.arrayContaining(['voiceTalkToAgent', 'voiceTalkToConductor'])
				);
			}
		);

		it('still matches on the label itself', () => {
			expect(search('conductor')).toEqual(['voiceTalkToConductor']);
		});

		it('does not match an unrelated search', () => {
			expect(search('worktree')).toEqual([]);
		});
	});
});
