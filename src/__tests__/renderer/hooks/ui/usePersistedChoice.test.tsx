/**
 * `usePersistedChoice` - one value out of a fixed option list, remembered under
 * a localStorage key.
 *
 * Two behaviours are worth pinning: a stored value that is no longer an option
 * must fall back to the default (otherwise an old build's mode strands the
 * surface in a state its control cannot express), and a blocked Storage must
 * cost the user persistence rather than the pane.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { usePersistedChoice } from '../../../../renderer/hooks/ui/usePersistedChoice';

const KEY = 'test.choice';
const OPTIONS = ['name', 'newest', 'oldest'] as const;
type Option = (typeof OPTIONS)[number];

function mount(defaultValue: Option = 'name') {
	return renderHook(() => usePersistedChoice<Option>(KEY, OPTIONS, defaultValue));
}

describe('usePersistedChoice', () => {
	beforeEach(() => {
		installLocalStorageMock();
	});

	it('starts at the default with nothing persisted', () => {
		expect(mount().result.current.value).toBe('name');
		expect(mount('newest').result.current.value).toBe('newest');
	});

	it('reads a stored value in preference to the default', () => {
		window.localStorage.setItem(KEY, 'oldest');
		expect(mount().result.current.value).toBe('oldest');
	});

	it('falls back to the default when the stored value is not an option', () => {
		window.localStorage.setItem(KEY, 'by-vibes');
		expect(mount().result.current.value).toBe('name');
	});

	it('persists a change and hands it to the next mount', () => {
		const { result } = mount();
		act(() => result.current.setValue('newest'));
		expect(result.current.value).toBe('newest');
		expect(window.localStorage.getItem(KEY)).toBe('newest');
		expect(mount().result.current.value).toBe('newest');
	});

	it('keeps separate keys independent', () => {
		const a = renderHook(() => usePersistedChoice<Option>('surface.a', OPTIONS, 'name'));
		act(() => a.result.current.setValue('newest'));
		const b = renderHook(() => usePersistedChoice<Option>('surface.b', OPTIONS, 'name'));
		expect(b.result.current.value).toBe('name');
	});

	it('still works in memory when Storage throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});
		const { result } = mount();
		expect(result.current.value).toBe('name');
		act(() => result.current.setValue('newest'));
		expect(result.current.value).toBe('newest');
	});
});
