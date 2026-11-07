/**
 * @file DictationHost.test.tsx
 *
 * The app-wide half of dictation. Properties worth protecting:
 *
 *   - **Readiness maps to what a button may draw**: off (the default) and a
 *     web-desktop client hide it, unavailable carries the reason.
 *   - **The shortcut dictates into the focused text box**: a tap toggles, a
 *     hold records until any key comes up or the window loses focus.
 *   - **A recording is always visible**, with Stop and Discard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const service = vi.hoisted(() => ({
	DICTATION_SHORTCUT_PRESS_EVENT: 'maestro:dictationShortcutPress',
	startDictation: vi.fn(),
	stopDictation: vi.fn(),
	cancelDictation: vi.fn(),
	toggleDictation: vi.fn(),
	focusedDictationTarget: vi.fn(),
	setDictationAvailabilityRefresher: vi.fn(() => () => {}),
}));
vi.mock('../../../renderer/services/dictation', () => service);
vi.mock('../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => false }));

import {
	DictationHost,
	dictationAvailabilityFromReadiness,
} from '../../../renderer/components/DictationHost';
import { resetDictationStore, useDictationStore } from '../../../renderer/stores/dictationStore';
import { useVoiceUiStore } from '../../../renderer/stores/voiceUiStore';
import type { LocalModelTaskReadiness } from '../../../shared/local-models/task-readiness';
import type { DictationTarget } from '../../../renderer/utils/dictationTargets';
import { mockTheme } from '../../helpers/mockTheme';

const HOLD_MS = 250;
const target: DictationTarget = { getElement: () => null, insert: () => true };

function verdict(overrides: Partial<LocalModelTaskReadiness>): LocalModelTaskReadiness {
	return {
		taskId: 'dictation',
		label: 'Dictation',
		needs: 'stt',
		assignment: { type: 'local', modelId: 'parakeet-tdt-0.6b-v2' },
		state: 'ready',
		detail: 'Runs on Parakeet.',
		...overrides,
	} as LocalModelTaskReadiness;
}

function pressShortcut() {
	act(() => {
		window.dispatchEvent(new CustomEvent(service.DICTATION_SHORTCUT_PRESS_EVENT));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetDictationStore();
	useVoiceUiStore.setState({ holdThresholdMs: HOLD_MS, loaded: true });
	service.focusedDictationTarget.mockReturnValue(target);
	vi.mocked(window.maestro.localModels.taskReadiness).mockResolvedValue([]);
});

describe('dictationAvailabilityFromReadiness', () => {
	it('hides dictation until main has answered, and while the task is off', () => {
		expect(dictationAvailabilityFromReadiness(undefined, [], false)).toEqual({ state: 'hidden' });
		expect(dictationAvailabilityFromReadiness(verdict({ state: 'off' }), [], false)).toEqual({
			state: 'hidden',
		});
	});

	it('is ready when the assigned source would answer', () => {
		expect(dictationAvailabilityFromReadiness(verdict({}), [], false).state).toBe('ready');
	});

	it('carries the reason and the recovery when the source cannot run', () => {
		expect(
			dictationAvailabilityFromReadiness(
				verdict({
					state: 'unavailable',
					detail: 'Parakeet is not downloaded.',
					suggestedAction: 'Download it in Settings -> Local Models.',
				}),
				[],
				false
			)
		).toEqual({
			state: 'unavailable',
			reason: 'Parakeet is not downloaded. Download it in Settings -> Local Models.',
		});
	});

	it('is always hidden on a web-desktop client, which has no microphone here', () => {
		expect(dictationAvailabilityFromReadiness(verdict({}), [], true)).toEqual({ state: 'hidden' });
	});
});

describe('readiness mirror', () => {
	it('asks main for the dictation task and mirrors the verdict into the store', async () => {
		vi.mocked(window.maestro.localModels.taskReadiness).mockResolvedValue([verdict({})]);
		render(<DictationHost theme={mockTheme} />);

		await vi.waitFor(() => expect(useDictationStore.getState().availability.state).toBe('ready'));
		expect(window.maestro.localModels.taskReadiness).toHaveBeenCalledWith('dictation');
	});
});

describe('the shortcut', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('toggles into the focused text box on a tap', () => {
		render(<DictationHost theme={mockTheme} />);

		pressShortcut();
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }));
		});

		expect(service.toggleDictation).toHaveBeenCalledWith(target);
		expect(service.startDictation).not.toHaveBeenCalled();
	});

	it('records while the chord is held and stops when any key comes up', () => {
		render(<DictationHost theme={mockTheme} />);

		pressShortcut();
		act(() => vi.advanceTimersByTime(HOLD_MS + 10));
		expect(service.startDictation).toHaveBeenCalledWith(target);

		// macOS does not deliver the letter's keyup while Command is held, so the
		// modifier coming up has to end the hold.
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
		});
		expect(service.stopDictation).toHaveBeenCalledTimes(1);
	});

	it('ends a hold when the window loses focus', () => {
		render(<DictationHost theme={mockTheme} />);
		pressShortcut();
		act(() => vi.advanceTimersByTime(HOLD_MS + 10));

		act(() => {
			window.dispatchEvent(new Event('blur'));
		});
		expect(service.stopDictation).toHaveBeenCalledTimes(1);
	});

	it('counts a held chord once however many times the key repeats', () => {
		render(<DictationHost theme={mockTheme} />);
		pressShortcut();
		pressShortcut();
		pressShortcut();
		act(() => vi.advanceTimersByTime(HOLD_MS + 10));
		expect(service.startDictation).toHaveBeenCalledTimes(1);
	});

	it('ignores a keyup that no press is waiting for', () => {
		render(<DictationHost theme={mockTheme} />);
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
		});
		expect(service.toggleDictation).not.toHaveBeenCalled();
		expect(service.stopDictation).not.toHaveBeenCalled();
	});
});

describe('the indicator', () => {
	it('draws nothing while idle', () => {
		render(<DictationHost theme={mockTheme} />);
		expect(screen.queryByTestId('dictation-indicator')).toBeNull();
	});

	it('shows a recording with Stop and Discard', () => {
		useDictationStore.setState({ phase: 'recording', target });
		render(<DictationHost theme={mockTheme} />);

		expect(screen.getByTestId('dictation-indicator')).toHaveTextContent('Dictating');
		fireEvent.click(screen.getByTestId('dictation-indicator-stop'));
		expect(service.stopDictation).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByTestId('dictation-indicator-discard'));
		expect(service.cancelDictation).toHaveBeenCalledTimes(1);
	});

	it('offers only Discard while the clip is being transcribed', () => {
		useDictationStore.setState({ phase: 'transcribing', target });
		render(<DictationHost theme={mockTheme} />);

		expect(screen.getByTestId('dictation-indicator')).toHaveTextContent('Transcribing');
		expect(screen.queryByTestId('dictation-indicator-stop')).toBeNull();
		expect(screen.getByTestId('dictation-indicator-discard')).toBeInTheDocument();
	});
});
