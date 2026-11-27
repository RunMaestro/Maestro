/**
 * @file DictationButton.test.tsx
 *
 * The microphone beside a text box. Properties worth protecting:
 *
 *   - **Hidden unless the dictation task is on.** Off is the default, so a
 *     text box must look exactly as it did.
 *   - **Unavailable is drawn, dimmed, with the reason.**
 *   - **A tap toggles; a hold records while held.**
 *   - **Only the button of the text box being dictated into shows recording.**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const service = vi.hoisted(() => ({
	startDictation: vi.fn(),
	stopDictation: vi.fn(),
	toggleDictation: vi.fn(),
	registerDictationTarget: vi.fn(() => () => {}),
}));
vi.mock('../../../../renderer/services/dictation', () => service);

import { DictationButton } from '../../../../renderer/components/ui/DictationButton';
import { resetDictationStore, useDictationStore } from '../../../../renderer/stores/dictationStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import type { DictationTarget } from '../../../../renderer/utils/dictationTargets';
import { mockTheme } from '../../../helpers/mockTheme';

const HOLD_MS = 250;
const target: DictationTarget = { getElement: () => null, insert: () => true };
const other: DictationTarget = { getElement: () => null, insert: () => true };

function ready() {
	useDictationStore.setState({ availability: { state: 'ready', source: 'Parakeet' } });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	resetDictationStore();
	useVoiceUiStore.setState({ holdThresholdMs: HOLD_MS });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the hidden state', () => {
	it('draws nothing while the task is off, but still registers its target', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		expect(screen.queryByTestId('dictation-button')).toBeNull();
		expect(service.registerDictationTarget).toHaveBeenCalledWith(target);
	});

	it('appears when the task becomes ready', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		act(() => ready());
		expect(screen.getByTestId('dictation-button')).toHaveAttribute('data-dictation-state', 'idle');
	});

	it('draws dimmed with the readiness reason when the source cannot run', () => {
		useDictationStore.setState({
			availability: { state: 'unavailable', reason: 'Parakeet is not downloaded. Download it.' },
		});
		render(<DictationButton theme={mockTheme} target={target} />);

		const button = screen.getByTestId('dictation-button');
		expect(button).toHaveAttribute('data-dictation-state', 'unavailable');
		expect(button).toHaveAttribute(
			'title',
			'Dictation is unavailable: Parakeet is not downloaded. Download it.'
		);
	});
});

describe('hold versus tap', () => {
	beforeEach(ready);

	it('toggles on a tap', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		const button = screen.getByTestId('dictation-button');

		fireEvent.pointerDown(button, { button: 0 });
		act(() => vi.advanceTimersByTime(HOLD_MS - 50));
		fireEvent.pointerUp(button);

		expect(service.toggleDictation).toHaveBeenCalledWith(target);
		expect(service.startDictation).not.toHaveBeenCalled();
		expect(service.stopDictation).not.toHaveBeenCalled();
	});

	it('records while held and stops on release', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		const button = screen.getByTestId('dictation-button');

		fireEvent.pointerDown(button, { button: 0 });
		act(() => vi.advanceTimersByTime(HOLD_MS + 10));
		expect(service.startDictation).toHaveBeenCalledWith(target);
		expect(service.stopDictation).not.toHaveBeenCalled();

		fireEvent.pointerUp(button);
		expect(service.stopDictation).toHaveBeenCalledTimes(1);
		expect(service.toggleDictation).not.toHaveBeenCalled();
	});

	it('stops a hold released away from the button', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		fireEvent.pointerDown(screen.getByTestId('dictation-button'), { button: 0 });
		act(() => vi.advanceTimersByTime(HOLD_MS + 10));

		act(() => {
			window.dispatchEvent(new Event('pointerup'));
		});
		expect(service.stopDictation).toHaveBeenCalledTimes(1);
	});

	it('does not restart a recording that a hold finds already running', () => {
		useDictationStore.setState({ phase: 'recording', target });
		render(<DictationButton theme={mockTheme} target={target} />);
		const button = screen.getByTestId('dictation-button');

		fireEvent.pointerDown(button, { button: 0 });
		act(() => vi.advanceTimersByTime(HOLD_MS + 10));
		expect(service.startDictation).not.toHaveBeenCalled();

		fireEvent.pointerUp(button);
		expect(service.stopDictation).toHaveBeenCalledTimes(1);
	});

	it('ignores a press that is not the primary button', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		const button = screen.getByTestId('dictation-button');
		fireEvent.pointerDown(button, { button: 2 });
		fireEvent.pointerUp(button);
		expect(service.toggleDictation).not.toHaveBeenCalled();
	});

	it('toggles from the keyboard', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		fireEvent.keyDown(screen.getByTestId('dictation-button'), { key: 'Enter' });
		expect(service.toggleDictation).toHaveBeenCalledWith(target);
	});

	it('keeps the caret in the text box when clicked', () => {
		render(<DictationButton theme={mockTheme} target={target} />);
		const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		screen.getByTestId('dictation-button').dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});
});

describe('which button is recording', () => {
	beforeEach(ready);

	it('shows recording only on the text box being dictated into', () => {
		useDictationStore.setState({ phase: 'recording', target });
		render(
			<>
				<DictationButton theme={mockTheme} target={target} testId="mine" />
				<DictationButton theme={mockTheme} target={other} testId="theirs" />
			</>
		);

		expect(screen.getByTestId('mine')).toHaveAttribute('data-dictation-state', 'recording');
		expect(screen.getByTestId('mine')).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByTestId('theirs')).toHaveAttribute('data-dictation-state', 'busy');
	});

	it('does nothing when another text box holds the microphone', () => {
		useDictationStore.setState({ phase: 'recording', target: other });
		render(<DictationButton theme={mockTheme} target={target} />);
		const button = screen.getByTestId('dictation-button');

		fireEvent.pointerDown(button, { button: 0 });
		fireEvent.pointerUp(button);
		fireEvent.keyDown(button, { key: ' ' });

		expect(service.toggleDictation).not.toHaveBeenCalled();
		expect(service.stopDictation).not.toHaveBeenCalled();
	});
});
