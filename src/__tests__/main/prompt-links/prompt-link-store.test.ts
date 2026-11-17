import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PromptLinkStore, hashPromptLinkToken } from '../../../main/prompt-links/prompt-link-store';
import { parseMaestroDeepLink } from '../../../shared/deep-link-urls';

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'prompt-links-'));
	file = path.join(dir, 'prompt-links.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The token inside a created URL. */
function tokenOf(url: string): string {
	const parsed = parseMaestroDeepLink(url);
	if (!parsed?.token) throw new Error(`not a run URL: ${url}`);
	return parsed.token;
}

const INPUT = { agentId: 'agent-1', prompt: 'Prep me for standup' };

describe('PromptLinkStore', () => {
	it('starts empty when the file is missing', () => {
		expect(new PromptLinkStore(file).list()).toEqual([]);
	});

	it('creates a one-shot background link by default and returns its URL once', async () => {
		const store = new PromptLinkStore(file);
		const { link, url } = await store.create(INPUT);
		expect(url).toMatch(/^maestro:\/\/run\/[A-Za-z0-9_-]{43}$/);
		expect(link).toMatchObject({
			agentId: 'agent-1',
			prompt: 'Prep me for standup',
			maxUses: 1,
			useCount: 0,
			open: 'background',
		});
		expect('tokenHash' in link).toBe(false);
	});

	it('stores only a hash of the token, never the token or the URL', async () => {
		const store = new PromptLinkStore(file);
		const { url } = await store.create(INPUT);
		await store.flushForTests();
		const raw = readFileSync(file, 'utf8');
		const token = tokenOf(url);
		expect(raw).not.toContain(token);
		expect(JSON.parse(raw).links[0].tokenHash).toBe(hashPromptLinkToken(token));
	});

	it('mints a different token for every link', async () => {
		const store = new PromptLinkStore(file);
		const a = await store.create(INPUT);
		const b = await store.create(INPUT);
		expect(a.url).not.toBe(b.url);
	});

	it('rejects invalid input with the shared sentence', async () => {
		const store = new PromptLinkStore(file);
		await expect(store.create({ agentId: 'a', prompt: ' ' })).rejects.toThrow(/prompt/i);
	});

	it('persists and reloads, newest first', async () => {
		const store = new PromptLinkStore(file);
		await store.create({ ...INPUT, label: 'first' }, 1000);
		await store.create({ ...INPUT, label: 'second' }, 2000);
		await store.flushForTests();
		const labels = new PromptLinkStore(file).list().map((l) => l.label);
		expect(labels).toEqual(['second', 'first']);
	});

	it('drops records it cannot trust instead of failing to load', () => {
		writeFileSync(file, JSON.stringify({ version: 1, links: [{ id: 'x' }, 'junk', null] }), 'utf8');
		expect(new PromptLinkStore(file).list()).toEqual([]);
	});

	describe('reserve / commit / release', () => {
		it('refuses an unknown token', () => {
			const store = new PromptLinkStore(file);
			expect(store.reserve('no-such-token')).toEqual({ ok: false, reason: 'not-found' });
		});

		it('spends a one-shot link on commit', async () => {
			const store = new PromptLinkStore(file);
			const token = tokenOf((await store.create(INPUT)).url);
			const first = store.reserve(token);
			expect(first.ok).toBe(true);
			if (first.ok) first.commit();
			const second = store.reserve(token);
			expect(second).toMatchObject({ ok: false, reason: 'spent' });
			expect(store.list()[0]).toMatchObject({ useCount: 1, lastUsedAt: expect.any(Number) });
		});

		it('refuses a second delivery while the first is in flight', async () => {
			const store = new PromptLinkStore(file);
			const token = tokenOf((await store.create({ ...INPUT, maxUses: null })).url);
			const first = store.reserve(token);
			expect(first.ok).toBe(true);
			expect(store.reserve(token)).toMatchObject({ ok: false, reason: 'in-flight' });
		});

		it('keeps the use when the delivery is released', async () => {
			const store = new PromptLinkStore(file);
			const token = tokenOf((await store.create(INPUT)).url);
			const first = store.reserve(token);
			if (first.ok) first.release();
			expect(store.list()[0].useCount).toBe(0);
			expect(store.reserve(token).ok).toBe(true);
		});

		it('settles once: a release after a commit does not refund the use', async () => {
			const store = new PromptLinkStore(file);
			const token = tokenOf((await store.create({ ...INPUT, maxUses: 2 })).url);
			const r = store.reserve(token);
			if (!r.ok) throw new Error('expected a reservation');
			r.commit();
			r.release();
			r.commit();
			expect(store.list()[0].useCount).toBe(1);
		});

		it('runs a limited link exactly its number of times', async () => {
			const store = new PromptLinkStore(file);
			const token = tokenOf((await store.create({ ...INPUT, maxUses: 3 })).url);
			for (let i = 0; i < 3; i++) {
				const r = store.reserve(token);
				expect(r.ok).toBe(true);
				if (r.ok) r.commit();
			}
			expect(store.reserve(token)).toMatchObject({ ok: false, reason: 'spent' });
		});

		it('refuses an expired link', async () => {
			const store = new PromptLinkStore(file);
			const token = tokenOf((await store.create({ ...INPUT, expiresAt: 5000 }, 1000)).url);
			expect(store.reserve(token, 4999).ok).toBe(true);
			const late = new PromptLinkStore(file);
			await store.flushForTests();
			expect(late.reserve(token, 5000)).toMatchObject({ ok: false, reason: 'expired' });
		});
	});

	describe('revoke', () => {
		it('revokes by unique id prefix, and the link never runs again', async () => {
			const store = new PromptLinkStore(file);
			const { link, url } = await store.create({ ...INPUT, maxUses: null });
			const revoked = await store.revoke(link.id.slice(0, 8));
			expect(revoked.revokedAt).toEqual(expect.any(Number));
			expect(store.reserve(tokenOf(url))).toMatchObject({ ok: false, reason: 'revoked' });
		});

		it('is idempotent', async () => {
			const store = new PromptLinkStore(file);
			const { link } = await store.create(INPUT);
			const first = await store.revoke(link.id, 100);
			const second = await store.revoke(link.id, 200);
			expect(second.revokedAt).toBe(first.revokedAt);
		});

		it('refuses an id that matches nothing', async () => {
			const store = new PromptLinkStore(file);
			await expect(store.revoke('nope')).rejects.toThrow(/No prompt link/);
		});
	});
});
