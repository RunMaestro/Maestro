import { describe, expect, it } from 'vitest';
import { parseStreamTokenCount, StreamProgress } from '../../maestro-p/stream-progress';

describe('parseStreamTokenCount', () => {
	it.each([
		['  ✢ Cooking… (9s · ↓ 420 tokens)', 420],
		['✻ Galloping… (2m 31s · ↓ 4.3k tokens · esc to interrupt)', 4300],
		['· Thinking… (12s · ↑ 1,204 tokens)', 1204],
		['✶ Pondering… (40m · ↓ 1.2M tokens)', 1_200_000],
	])('reads %j as %d', (screen, count) => {
		expect(parseStreamTokenCount(screen)).toBe(count);
	});

	it('reads the newest spinner frame when several are on screen', () => {
		const screen = '✢ Cooking… (9s · ↓ 420 tokens)\n> prompt\n✻ Cooking… (10s · ↓ 431 tokens)';
		expect(parseStreamTokenCount(screen)).toBe(431);
	});

	it('returns null when no counter is shown', () => {
		expect(parseStreamTokenCount('> waiting for input')).toBeNull();
		expect(parseStreamTokenCount('')).toBeNull();
	});
});

describe('StreamProgress', () => {
	it('treats the first count as a baseline, not progress', () => {
		const progress = new StreamProgress();
		progress.observe(420, 1_000);
		expect(progress.getLastProgressAt()).toBe(0);
	});

	it('records progress when the count changes', () => {
		const progress = new StreamProgress();
		progress.observe(420, 1_000);
		progress.observe(900, 11_000);
		expect(progress.getLastProgressAt()).toBe(11_000);
	});

	it('holds the last progress time while the count is frozen (a hung stream)', () => {
		const progress = new StreamProgress();
		progress.observe(420, 1_000);
		progress.observe(900, 11_000);
		progress.observe(900, 21_000);
		progress.observe(900, 31_000);
		expect(progress.getLastProgressAt()).toBe(11_000);
	});

	it('ignores samples where no counter was on screen', () => {
		const progress = new StreamProgress();
		progress.observe(420, 1_000);
		progress.observe(null, 11_000);
		progress.observe(420, 21_000);
		expect(progress.getLastProgressAt()).toBe(0);
	});

	it('counts a reset to a lower number (a new request) as progress', () => {
		const progress = new StreamProgress();
		progress.observe(4_300, 1_000);
		progress.observe(120, 11_000);
		expect(progress.getLastProgressAt()).toBe(11_000);
	});
});
