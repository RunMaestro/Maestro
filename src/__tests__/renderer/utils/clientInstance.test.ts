import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getClientInstanceId,
	isReloadedClientInstance,
	resetClientInstanceForTests,
} from '../../../renderer/utils/clientInstance';

const KEY = 'maestro:clientInstanceId';

function mockNavigationType(type: string): void {
	vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
		{ type } as unknown as PerformanceEntry,
	]);
}

describe('clientInstance', () => {
	beforeEach(() => {
		sessionStorage.clear();
		resetClientInstanceForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
	});

	it('mints and remembers an id on a fresh page', () => {
		mockNavigationType('navigate');
		const id = getClientInstanceId();
		expect(id).toBeTruthy();
		expect(getClientInstanceId()).toBe(id);
		expect(sessionStorage.getItem(KEY)).toBe(id);
		expect(isReloadedClientInstance()).toBe(false);
	});

	it('keeps the id across a reload of the same tab', () => {
		sessionStorage.setItem(KEY, 'tab-before-reload');
		mockNavigationType('reload');
		expect(getClientInstanceId()).toBe('tab-before-reload');
		expect(isReloadedClientInstance()).toBe(true);
	});

	it('keeps the id when the browser restores a discarded tab', () => {
		sessionStorage.setItem(KEY, 'tab-before-discard');
		mockNavigationType('navigate');
		(document as Document & { wasDiscarded?: boolean }).wasDiscarded = true;
		expect(getClientInstanceId()).toBe('tab-before-discard');
		expect(isReloadedClientInstance()).toBe(true);
	});

	it('mints a fresh id for a duplicated tab, which inherits sessionStorage without reloading', () => {
		sessionStorage.setItem(KEY, 'parent-tab');
		mockNavigationType('navigate');
		expect(getClientInstanceId()).not.toBe('parent-tab');
		expect(isReloadedClientInstance()).toBe(false);
	});

	it('is not a reload when there was no earlier id', () => {
		mockNavigationType('reload');
		expect(isReloadedClientInstance()).toBe(false);
	});
});
