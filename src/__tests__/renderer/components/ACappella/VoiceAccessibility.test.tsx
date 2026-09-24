/**
 * The voice UI, for people who are not looking at it.
 *
 * A HUD that is designed to sit on screen all day has two obligations most
 * widgets do not: it must stop moving when the user has asked for less motion,
 * and it must say what it is doing in words, because "the ring is pulsing" is
 * not information a screen reader can convey. Both are covered here, along with
 * keyboard reachability and the colour contrast of every state against every
 * shipped theme.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { VoiceHud } from '../../../../renderer/components/ACappella';
import { VoiceIndicator } from '../../../../renderer/components/ACappella/VoiceIndicator';
import { VoicePillMenu } from '../../../../renderer/components/VoicePillMenu';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import { contrastRatio, readableTextOn } from '../../../../shared/colorContrast';
import { THEMES, type Theme } from '../../../../shared/themes';
import {
	VOICE_HUD_STATE_LABELS,
	type VoiceHudVisualState,
} from '../../../../shared/acappella/hud-state';
import { mockTheme } from '../../../helpers/mockTheme';
import type { VoiceEvent } from '../../../../shared/acappella/protocol';

const SESSION = 'voice-1';
let seq = 0;

function event<T extends VoiceEvent['type']>(
	type: T,
	body: Omit<Extract<VoiceEvent, { type: T }>, 'type' | 'sessionId' | 'seq' | 'ts'>
): VoiceEvent {
	seq += 1;
	return {
		type,
		sessionId: SESSION,
		seq,
		ts: 1_700_000_000_000 + seq,
		...body,
	} as unknown as VoiceEvent;
}

function emit(...events: VoiceEvent[]): void {
	const calls = vi.mocked(window.maestro.voice.onEvent).mock.calls;
	const push = calls[calls.length - 1][0];
	act(() => {
		for (const e of events) push(e);
	});
}

function renderHud() {
	return render(
		<LayerStackProvider>
			<VoiceHud theme={mockTheme} enabled showDevHarness={false} />
		</LayerStackProvider>
	);
}

function startSession(): void {
	emit(
		event('wake', { source: 'client-button', scope: { kind: 'conductor' } }),
		event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' })
	);
}

/** Force the `prefers-reduced-motion` answer for this test. */
function setReducedMotion(reduce: boolean): void {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: query.includes('prefers-reduced-motion') ? reduce : false,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
	seq = 0;
	vi.clearAllMocks();
	vi.mocked(window.maestro.voice.onEvent).mockReturnValue(() => {});
	vi.mocked(window.maestro.voice.getState).mockResolvedValue(null);
	useVoiceSessionStore.getState().reset();
	useVoiceUiStore.setState({
		transcriptVisible: false,
		hudPosition: null,
		minimizeBehavior: 'manual',
		minimized: false,
		muted: false,
		loaded: true,
	});
	setReducedMotion(false);
});

afterEach(() => {
	cleanup();
});

describe('Reduced motion', () => {
	const STATES: VoiceHudVisualState[] = [
		'idle-armed',
		'listening',
		'thinking',
		'speaking',
		'error',
	];

	it('animates the live states by default', () => {
		render(<VoiceIndicator theme={mockTheme} state="listening" />);
		expect(screen.getByTestId('voice-indicator-listening').getAttribute('data-motion')).toBe(
			'animated'
		);
	});

	it.each(STATES)('renders %s without animation under reduced motion', (state) => {
		setReducedMotion(true);
		const { container } = render(<VoiceIndicator theme={mockTheme} state={state} />);

		const indicator = container.querySelector('[data-motion]');
		expect(indicator?.getAttribute('data-motion')).toBe('static');
		// No canned animation classes anywhere in the subtree: an always-animating
		// widget is a real problem for people with vestibular disorders, and this
		// one is designed to be left on screen all day.
		expect(container.querySelector('.animate-pulse')).toBeNull();
		expect(container.querySelector('.animate-spin')).toBeNull();
	});

	it('stops the level disc tracking the microphone under reduced motion', () => {
		setReducedMotion(true);
		render(<VoiceIndicator theme={mockTheme} state="listening" />);
		act(() => {
			useVoiceSessionStore.setState({ audioLevel: 0.25 });
		});

		const disc = screen.getByTestId('voice-hud-level') as HTMLElement;
		expect(disc.style.transform).toBe('');
		expect(disc.style.transition).toBe('');
	});
});

describe('Screen reader announcements', () => {
	it('has a polite live region that names the state and the bound scope', () => {
		renderHud();
		startSession();

		const region = screen.getByTestId('voice-hud-live-region');
		expect(region.getAttribute('role')).toBe('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		expect(region.textContent).toContain('Listening');
		expect(region.textContent).toContain('microphone is open');
		expect(region.textContent).toContain('Conductor');
	});

	it('announces the change when the state moves on', () => {
		renderHud();
		startSession();
		emit(event('speak-start', { utteranceId: 'u1', sentenceCount: 1, ttsProviderId: 'mock-tts' }));
		expect(screen.getByTestId('voice-hud-live-region').textContent).toContain('Speaking');
	});

	it('keeps announcing while minimized, because the microphone is still open', async () => {
		renderHud();
		startSession();
		await act(async () => {
			useVoiceUiStore.getState().setMinimized(true);
		});

		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(screen.getByTestId('voice-hud-live-region').textContent).toContain('Listening');
	});

	it('gives every state a text label rather than only a shape', () => {
		for (const state of Object.keys(VOICE_HUD_STATE_LABELS) as VoiceHudVisualState[]) {
			const { container, unmount } = render(<VoiceIndicator theme={mockTheme} state={state} />);
			const indicator = container.querySelector('[data-motion]');
			expect(indicator?.getAttribute('aria-label')).toBe(VOICE_HUD_STATE_LABELS[state]);
			unmount();
		}
	});
});

describe('Keyboard reachability', () => {
	it('gives every HUD control a real button with an accessible name', () => {
		renderHud();
		startSession();

		for (const testId of [
			'voice-hud-talk',
			'voice-hud-interrupt',
			'voice-hud-stop',
			'voice-hud-transcript-toggle',
			'voice-hud-mute',
			'voice-hud-minimize',
			'voice-hud-close',
		]) {
			const control = screen.getByTestId(testId);
			expect(control.tagName).toBe('BUTTON');
			expect(control.getAttribute('aria-label')).toBeTruthy();
			// A control reachable by Tab but with no visible focus ring is reachable
			// only in theory.
			expect(control.className).toContain('focus-visible:ring');
		}
	});

	it('does not trap focus: the HUD registers as a non-blocking layer', () => {
		renderHud();
		startSession();
		// Nothing in the HUD steals focus on mount, so a user mid-sentence in the
		// composer keeps typing while a voice session runs.
		expect(document.activeElement).toBe(document.body);
	});

	it('toggles the session from the keyboard alone', () => {
		renderHud();
		startSession();
		const talk = screen.getByTestId('voice-hud-talk');
		act(() => {
			talk.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		});
		expect(window.maestro.voice.stop).toHaveBeenCalled();
	});
});

describe('Header-anchored menu placement', () => {
	it('portals out of the header subtree rather than rendering inside it', () => {
		// jsdom has no layout engine, so `toBeInTheDocument()` passes on an element
		// that is clipped to invisibility. The check that actually means something
		// is that the menu is NOT a descendant of the header: `absolute top-full`
		// inside `.header-container` is silently cut off, and so is bare `fixed`,
		// because the header is a containing block for fixed descendants.
		const header = document.createElement('div');
		header.className = 'header-container';
		header.style.overflow = 'hidden';
		document.body.appendChild(header);
		const anchor = document.createElement('div');
		header.appendChild(anchor);

		render(
			<LayerStackProvider>
				<VoicePillMenu
					theme={mockTheme}
					anchorRef={{ current: anchor }}
					agentName="Backend"
					hasVoiceFloor={false}
					wakePhrase={null}
					transcriptVisible={false}
					onTalkToAgent={vi.fn()}
					onTalkToConductor={vi.fn()}
					onToggleTranscript={vi.fn()}
					onEndSession={vi.fn()}
					onClose={vi.fn()}
				/>
			</LayerStackProvider>
		);

		const menu = screen.getByTestId('voice-pill-menu');
		expect(header.contains(menu)).toBe(false);
		expect(menu.parentElement).toBe(document.body);

		header.remove();
	});
});

describe('Contrast against every shipped theme', () => {
	/** WCAG AA for the small text and icons this widget is made of. */
	const AA = 4.5;

	it.each(Object.entries(THEMES))(
		'%s clears AA for every voice state',
		(_id: string, theme: Theme) => {
			// Every colour the HUD derives runs through `readableTextOn` against the
			// surfaces it is actually painted on. This asserts the guarantee holds
			// for the real theme values rather than trusting it by inspection.
			const surfaces = [theme.colors.bgSidebar, theme.colors.bgMain];
			const derived = {
				accent: readableTextOn(theme.colors.accent, surfaces),
				warning: readableTextOn(theme.colors.warning, [theme.colors.bgSidebar]),
				error: readableTextOn(theme.colors.error, [theme.colors.bgSidebar]),
				onAccent: readableTextOn(theme.colors.accentForeground, [theme.colors.accent]),
			};

			expect(contrastRatio(derived.accent, theme.colors.bgSidebar)).toBeGreaterThanOrEqual(AA);
			expect(contrastRatio(derived.accent, theme.colors.bgMain)).toBeGreaterThanOrEqual(AA);
			expect(contrastRatio(derived.warning, theme.colors.bgSidebar)).toBeGreaterThanOrEqual(AA);
			expect(contrastRatio(derived.error, theme.colors.bgSidebar)).toBeGreaterThanOrEqual(AA);
			// The speaking indicator is a FILLED accent disc, so its glyph is read
			// against the accent rather than against the panel.
			expect(contrastRatio(derived.onAccent, theme.colors.accent)).toBeGreaterThanOrEqual(AA);
		}
	);
});
