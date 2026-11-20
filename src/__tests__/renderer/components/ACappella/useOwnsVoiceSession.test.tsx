/**
 * @file useOwnsVoiceSession.test.tsx
 *
 * One voice session, several windows. Every window receives the whole
 * `acappella:event` stream (the multi-window broadcast invariant), so each one
 * has to decide for itself whether the session is its own. Getting this wrong
 * draws the same HUD in every window and makes one microphone look like several.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Controlled WindowContext: `null` is "no WindowProvider" (a single-window host
// or an isolation test), which must permit everything rather than hide the HUD.
let mockWindow: { windowId: string | null; isMainWindow: boolean } | null = null;
vi.mock('../../../../renderer/contexts/WindowContext', () => ({
	useWindowContextOptional: () => mockWindow,
}));

let mockIsWebDesktop = false;
vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => mockIsWebDesktop,
}));

import { useOwnsVoiceSession } from '../../../../renderer/components/ACappella/useOwnsVoiceSession';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';

/** Put the mirrored session in the state a window would see after a `wake`. */
function sessionOwnedBy(windowId: string | null): void {
	useVoiceSessionStore.setState({ windowId });
}

function owns(): boolean {
	return renderHook(() => useOwnsVoiceSession()).result.current;
}

describe('useOwnsVoiceSession', () => {
	beforeEach(() => {
		mockWindow = null;
		mockIsWebDesktop = false;
		useVoiceSessionStore.getState().reset();
	});

	it('shows a session started in THIS window', () => {
		mockWindow = { windowId: 'w2', isMainWindow: false };
		sessionOwnedBy('w2');

		expect(owns()).toBe(true);
	});

	it('hides a session started in ANOTHER window', () => {
		// The bug this hook exists for: opening voice in one window drew an
		// identical HUD in every other one.
		mockWindow = { windowId: 'w2', isMainWindow: false };
		sessionOwnedBy('w1');

		expect(owns()).toBe(false);
	});

	it('hides another window’s session from the primary too', () => {
		// The primary window is not a catch-all here. It is the fallback for a
		// session that names NO window, not for one that names a different window.
		mockWindow = { windowId: 'w1', isMainWindow: true };
		sessionOwnedBy('w2');

		expect(owns()).toBe(false);
	});

	describe('a session that names no window', () => {
		it('lands on the primary, so it has exactly one surface', () => {
			mockWindow = { windowId: 'w1', isMainWindow: true };
			sessionOwnedBy(null);

			expect(owns()).toBe(true);
		});

		it('does not also land on a secondary window', () => {
			mockWindow = { windowId: 'w2', isMainWindow: false };
			sessionOwnedBy(null);

			expect(owns()).toBe(false);
		});
	});

	it('permits everything on web-desktop, which is not one of several windows', () => {
		mockIsWebDesktop = true;
		mockWindow = { windowId: null, isMainWindow: true };
		sessionOwnedBy('w2');

		expect(owns()).toBe(true);
	});

	it('permits everything with no WindowProvider, where no window can be the wrong one', () => {
		mockWindow = null;
		sessionOwnedBy('w2');

		expect(owns()).toBe(true);
	});
});
