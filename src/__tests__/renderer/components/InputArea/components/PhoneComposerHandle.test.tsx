/**
 * Tests for PhoneComposerHandle - the grip that folds the composer away on a
 * phone. Tap and swipe both toggle; the collapsed bar must still show that the
 * agent is working and that a draft is waiting behind the fold.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhoneComposerHandle } from '../../../../../renderer/components/InputArea/components/PhoneComposerHandle';
import { mockTheme } from '../../../../helpers/mockTheme';

describe('PhoneComposerHandle', () => {
	it('toggles on tap and names its state', () => {
		const onToggle = vi.fn();
		render(<PhoneComposerHandle theme={mockTheme} collapsed onToggle={onToggle} />);
		const handle = screen.getByTestId('phone-composer-handle');
		expect(handle).toHaveAttribute('aria-expanded', 'false');
		expect(handle).toHaveAccessibleName('Show composer');
		fireEvent.click(handle);
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it('reads as "hide" when the composer is open', () => {
		render(<PhoneComposerHandle theme={mockTheme} collapsed={false} onToggle={vi.fn()} />);
		const handle = screen.getByTestId('phone-composer-handle');
		expect(handle).toHaveAttribute('aria-expanded', 'true');
		expect(handle).toHaveAccessibleName('Hide composer');
	});

	it('reveals on a swipe up while collapsed, and ignores a swipe down', () => {
		const onToggle = vi.fn();
		render(<PhoneComposerHandle theme={mockTheme} collapsed onToggle={onToggle} />);
		const handle = screen.getByTestId('phone-composer-handle');

		fireEvent.touchStart(handle, { touches: [{ clientX: 100, clientY: 700 }] });
		fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 100, clientY: 760 }] });
		expect(onToggle).not.toHaveBeenCalled();

		fireEvent.touchStart(handle, { touches: [{ clientX: 100, clientY: 700 }] });
		fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 100, clientY: 620 }] });
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it('folds on a swipe down while open, and ignores a swipe up', () => {
		const onToggle = vi.fn();
		render(<PhoneComposerHandle theme={mockTheme} collapsed={false} onToggle={onToggle} />);
		const handle = screen.getByTestId('phone-composer-handle');

		fireEvent.touchStart(handle, { touches: [{ clientX: 100, clientY: 500 }] });
		fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 100, clientY: 420 }] });
		expect(onToggle).not.toHaveBeenCalled();

		fireEvent.touchStart(handle, { touches: [{ clientX: 100, clientY: 500 }] });
		fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 100, clientY: 580 }] });
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it('shows a busy dot and a draft pencil on the collapsed bar', () => {
		render(<PhoneComposerHandle theme={mockTheme} collapsed onToggle={vi.fn()} busy hasDraft />);
		expect(screen.getByTestId('phone-composer-handle-busy')).toBeInTheDocument();
		expect(screen.getByTestId('phone-composer-handle-draft')).toBeInTheDocument();
	});

	it('shows neither when idle with nothing pending', () => {
		render(<PhoneComposerHandle theme={mockTheme} collapsed onToggle={vi.fn()} />);
		expect(screen.queryByTestId('phone-composer-handle-busy')).not.toBeInTheDocument();
		expect(screen.queryByTestId('phone-composer-handle-draft')).not.toBeInTheDocument();
	});
});
