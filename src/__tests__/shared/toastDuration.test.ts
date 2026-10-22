import { describe, it, expect } from 'vitest';
import {
	areToastsEnabled,
	DEFAULT_TOAST_DURATION,
	resolveEnabledToastDuration,
	TOAST_DURATION_OFF,
} from '../../shared/toastDuration';

describe('areToastsEnabled', () => {
	it('is false only for the off sentinel', () => {
		expect(areToastsEnabled(TOAST_DURATION_OFF)).toBe(false);
		expect(areToastsEnabled(0)).toBe(true);
		expect(areToastsEnabled(5)).toBe(true);
	});
});

describe('resolveEnabledToastDuration', () => {
	it('restores a remembered positive duration', () => {
		expect(resolveEnabledToastDuration(5)).toBe(5);
	});

	it('restores "Never" (0) rather than treating it as missing', () => {
		expect(resolveEnabledToastDuration(0)).toBe(0);
	});

	it('falls back to the default for anything unusable', () => {
		expect(resolveEnabledToastDuration(TOAST_DURATION_OFF)).toBe(DEFAULT_TOAST_DURATION);
		expect(resolveEnabledToastDuration(undefined)).toBe(DEFAULT_TOAST_DURATION);
		expect(resolveEnabledToastDuration('10')).toBe(DEFAULT_TOAST_DURATION);
		expect(resolveEnabledToastDuration(Number.NaN)).toBe(DEFAULT_TOAST_DURATION);
	});
});
