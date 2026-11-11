/**
 * Follow System Appearance (#1953): the theme id comes from the device's
 * prefers-color-scheme when themeFollowSystem is on, and from activeThemeId
 * otherwise.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { pickThemeIdForAppearance } from '../../../../renderer/hooks/ui/useResolvedTheme';
import { usePrefersDarkColorScheme } from '../../../../renderer/hooks/ui/usePrefersDarkColorScheme';

describe('pickThemeIdForAppearance', () => {
	const base = {
		activeThemeId: 'nord',
		themeFollowSystem: false,
		lightThemeId: 'github-light',
		darkThemeId: 'dracula',
	};

	it('uses activeThemeId when not following the system, whatever the device says', () => {
		expect(pickThemeIdForAppearance(base, true)).toBe('nord');
		expect(pickThemeIdForAppearance(base, false)).toBe('nord');
	});

	it('uses the dark theme on a dark device and the light theme on a light one', () => {
		const following = { ...base, themeFollowSystem: true };
		expect(pickThemeIdForAppearance(following, true)).toBe('dracula');
		expect(pickThemeIdForAppearance(following, false)).toBe('github-light');
	});
});

describe('usePrefersDarkColorScheme', () => {
	const originalMatchMedia = window.matchMedia;

	afterEach(() => {
		window.matchMedia = originalMatchMedia;
	});

	function installMatchMedia(initialDark: boolean) {
		const listeners = new Set<() => void>();
		const query = {
			matches: initialDark,
			media: '(prefers-color-scheme: dark)',
			addEventListener: vi.fn((_: string, cb: () => void) => listeners.add(cb)),
			removeEventListener: vi.fn((_: string, cb: () => void) => listeners.delete(cb)),
		};
		window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia;
		return {
			query,
			flip(dark: boolean) {
				query.matches = dark;
				listeners.forEach((cb) => cb());
			},
		};
	}

	it('reads the device appearance and follows it when it changes', () => {
		const media = installMatchMedia(false);
		const { result, unmount } = renderHook(() => usePrefersDarkColorScheme());
		expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
		expect(result.current).toBe(false);

		act(() => media.flip(true));
		expect(result.current).toBe(true);

		unmount();
		expect(media.query.removeEventListener).toHaveBeenCalled();
	});
});
