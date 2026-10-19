/**
 * runtimeContext - which kind of renderer this page is. The answers are
 * memoized per page load, so every case loads a fresh copy of the module.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

type RuntimeContext = typeof import('../../../renderer/utils/runtimeContext');

async function loadWithSearch(search: string): Promise<RuntimeContext> {
	window.history.replaceState(null, '', `/${search}`);
	vi.resetModules();
	return import('../../../renderer/utils/runtimeContext');
}

afterEach(() => {
	delete (window as { __MAESTRO_CONFIG__?: unknown }).__MAESTRO_CONFIG__;
	window.history.replaceState(null, '', '/');
});

describe('getTabWindowId / isTabWindow', () => {
	it('reads the window id from ?tabWindow=<id>', async () => {
		const ctx = await loadWithSearch('?tabWindow=tw-42');
		expect(ctx.getTabWindowId()).toBe('tw-42');
		expect(ctx.isTabWindow()).toBe(true);
	});

	it('is not a tab window without the query', async () => {
		const ctx = await loadWithSearch('?windowId=w-2');
		expect(ctx.getTabWindowId()).toBeNull();
		expect(ctx.isTabWindow()).toBe(false);
	});

	it('is not a tab window when the query carries no id', async () => {
		const ctx = await loadWithSearch('?tabWindow=');
		expect(ctx.getTabWindowId()).toBeNull();
		expect(ctx.isTabWindow()).toBe(false);
	});

	it('is never a tab window in the web-desktop build (TW-13)', async () => {
		(window as { __MAESTRO_CONFIG__?: unknown }).__MAESTRO_CONFIG__ = { token: 't' };
		const ctx = await loadWithSearch('?tabWindow=tw-42');
		expect(ctx.isWebDesktop()).toBe(true);
		expect(ctx.isTabWindow()).toBe(false);
	});

	it('keeps its first answer for the life of the page', async () => {
		const ctx = await loadWithSearch('?tabWindow=tw-42');
		expect(ctx.isTabWindow()).toBe(true);
		window.history.replaceState(null, '', '/');
		expect(ctx.getTabWindowId()).toBe('tw-42');
	});
});
