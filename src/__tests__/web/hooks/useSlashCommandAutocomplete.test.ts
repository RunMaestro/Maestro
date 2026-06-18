/**
 * Tests for useSlashCommandAutocomplete hook
 *
 * Covers:
 * - Open/close behavior based on input value
 * - Manual open
 * - Command selection auto-submit flow
 * - Close handling for partial slash input
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSlashCommandAutocomplete } from '../../../web/hooks/useSlashCommandAutocomplete';

describe('useSlashCommandAutocomplete', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('opens when input starts with slash and has no spaces', () => {
		const { result } = renderHook(() =>
			useSlashCommandAutocomplete({
				inputValue: '',
				isControlled: true,
			})
		);

		act(() => {
			result.current.handleInputChange('/he');
		});

		expect(result.current.isOpen).toBe(true);

		act(() => {
			result.current.handleInputChange('/help me');
		});

		expect(result.current.isOpen).toBe(false);
	});

	it('opens autocomplete manually and resets selection', () => {
		const { result } = renderHook(() =>
			useSlashCommandAutocomplete({
				inputValue: '',
				isControlled: true,
			})
		);

		act(() => {
			result.current.setSelectedIndex(3);
			result.current.openAutocomplete();
		});

		expect(result.current.isOpen).toBe(true);
		expect(result.current.selectedIndex).toBe(0);
	});

	it('handles command selection and auto-submit', () => {
		const onChange = vi.fn();
		const onSubmit = vi.fn();
		const focus = vi.fn();
		const inputRef = { current: { focus } } as React.RefObject<HTMLTextAreaElement>;

		const { result } = renderHook(() =>
			useSlashCommandAutocomplete({
				inputValue: '/he',
				isControlled: true,
				onChange,
				onSubmit,
				inputRef,
			})
		);

		act(() => {
			result.current.handleSelectCommand('/help');
		});

		expect(onChange).toHaveBeenCalledWith('/help');
		expect(result.current.isOpen).toBe(false);
		expect(focus).toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(50);
		});

		expect(onSubmit).toHaveBeenCalledWith('/help');
		expect(onChange).toHaveBeenCalledWith('');
	});

	it('clears partial slash input on close', () => {
		const onChange = vi.fn();

		const { result } = renderHook(() =>
			useSlashCommandAutocomplete({
				inputValue: '/hel',
				isControlled: true,
				onChange,
			})
		);

		act(() => {
			result.current.handleClose();
		});

		expect(result.current.isOpen).toBe(false);
		expect(onChange).toHaveBeenCalledWith('');
	});
});
