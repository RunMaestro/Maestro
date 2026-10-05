import { describe, expect, it, vi } from 'vitest';

const relocate = (value: unknown): unknown => {
	if (typeof value === 'string')
		return value.replace('data:image/png;base64,AAAA', 'maestro-image://store/abc.png');
	if (Array.isArray(value)) return value.map(relocate);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v)]));
	}
	return value;
};
vi.mock('../../../main/storage/session-image-store', () => ({
	relocateSessionImages: async (sessions: any[]) => ({
		sessions: sessions.map(relocate),
		relocated: 1,
	}),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyFoldBoundary } from '../../../main/library-runtime/fold-boundary';
import type { DesktopFold } from '../../../shared/maestro-lib/agents/desktop-fold-types';

const entry = (extra: Record<string, unknown> = {}) => ({
	id: 'a1',
	provider: 'claude-code',
	fields: { inputMode: 'ai' },
	tabs: {} as Record<string, Record<string, unknown>>,
	...extra,
});

describe('the fold boundary', () => {
	it('moves inline images out of a tab transcript and keeps the entry shape', async () => {
		const fold: DesktopFold = {
			agents: [
				entry({
					tabs: {
						t1: { logs: [{ id: 'l1', images: ['data:image/png;base64,AAAA'] }], scrollTop: 4 },
					},
				}),
			],
		};
		const out = await applyFoldBoundary(fold, () => undefined);
		expect(out.agents[0].id).toBe('a1');
		expect(out.agents[0].fields).toEqual({ inputMode: 'ai' });
		expect(out.agents[0].tabs.t1.scrollTop).toBe(4);
		expect((out.agents[0].tabs.t1.logs as any[])[0].images).toEqual([
			'maestro-image://store/abc.png',
		]);
		expect(fold.agents[0].tabs.t1.logs).toEqual([
			{ id: 'l1', images: ['data:image/png;base64,AAAA'] },
		]);
	});

	it('relocates images in adopted agents and adopted tabs', async () => {
		const fold: DesktopFold = {
			agents: [
				entry({
					adoptTabs: [{ id: 't9', logs: [{ id: 'l', images: ['data:image/png;base64,AAAA'] }] }],
				}),
			],
			adoptAgents: [
				{
					id: 'a2',
					name: 'New',
					aiTabs: [{ id: 't', stagedImages: ['data:image/png;base64,AAAA'] }],
				},
			],
		};
		const out = await applyFoldBoundary(fold, () => undefined);
		expect((out.agents[0].adoptTabs?.[0].logs as any[])[0].images).toEqual([
			'maestro-image://store/abc.png',
		]);
		expect((out.adoptAgents?.[0].aiTabs as any[])[0].stagedImages).toEqual([
			'maestro-image://store/abc.png',
		]);
		expect(out.adoptAgents?.[0].name).toBe('New');
	});

	it('leaves a key an entry set to undefined as undefined, so the applier deletes it', async () => {
		const out = await applyFoldBoundary(
			{ agents: [entry({ fields: { inputMode: undefined } })] },
			() => undefined
		);
		expect('inputMode' in out.agents[0].fields).toBe(true);
		expect(out.agents[0].fields.inputMode).toBeUndefined();
	});

	it('drops an adoption that carries deferred content, since it has nothing stored to merge into', async () => {
		const out = await applyFoldBoundary(
			{
				agents: [],
				adoptAgents: [
					{ id: 'a2', deferredContent: { tabIds: ['t'], commands: true } },
					{ id: 'a3' },
				],
			},
			() => undefined
		);
		expect(out.adoptAgents?.map((a) => a.id)).toEqual(['a3']);
	});

	it('merges a browser transcript into the stored one before it lands', async () => {
		const stored = { id: 'a1', aiTabs: [{ id: 't1', logs: [{ id: 'old', timestamp: 1 }] }] } as any;
		const fold: DesktopFold = {
			agents: [
				entry({
					fields: { deferredContent: { tabIds: ['t1'], commands: false } },
					tabs: { t1: { logs: [{ id: 'new', timestamp: 2 }] } },
				}),
			],
		};
		const out = await applyFoldBoundary(fold, () => stored);
		expect((out.agents[0].tabs.t1.logs as any[]).map((l) => l.id)).toEqual(['old', 'new']);
		expect(out.agents[0].fields).not.toHaveProperty('deferredContent');
	});
});
