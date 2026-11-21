import { describe, it, expect, vi, beforeEach } from 'vitest';

const store: Record<string, unknown> = {};

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn((key: string) => store[key]),
	writeSettingValue: vi.fn((key: string, value: unknown) => {
		store[key] = value;
		return true;
	}),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg: string) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg: string) => `Success: ${msg}`),
	formatWarning: vi.fn((msg: string) => `Warning: ${msg}`),
}));
vi.mock('../../../cli/output/jsonl', () => ({ emitJsonl: vi.fn() }));

import { displayHeading } from '../../../cli/commands/display-heading';
import { emitJsonl } from '../../../cli/output/jsonl';

beforeEach(() => {
	for (const key of Object.keys(store)) delete store[key];
	store.fontZoom = 1;
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	process.exitCode = undefined;
});

describe('display heading', () => {
	it('sets a level font and size in one call', () => {
		displayHeading('h1', { font: 'Georgia', size: '28' });
		expect(store.headingTypography).toEqual({ h1: { fontFamily: 'Georgia', fontSize: 28 } });
		expect(process.exitCode).toBeUndefined();
	});

	it('patches one field without touching the other', () => {
		store.headingTypography = { h2: { fontFamily: 'Georgia', fontSize: 24 } };
		displayHeading('H2', { size: '30px' });
		expect(store.headingTypography).toEqual({ h2: { fontFamily: 'Georgia', fontSize: 30 } });
	});

	it('clears a field with "default" and drops the level when nothing is left', () => {
		store.headingTypography = { h3: { fontFamily: '', fontSize: 20 } };
		displayHeading('3', { size: 'default' });
		expect(store.headingTypography).toEqual({});
	});

	it('resets one level, or every level when none is named', () => {
		store.headingTypography = {
			h1: { fontFamily: 'Georgia', fontSize: 0 },
			h2: { fontFamily: '', fontSize: 22 },
		};
		displayHeading('h1', { reset: true });
		expect(store.headingTypography).toEqual({ h2: { fontFamily: '', fontSize: 22 } });
		displayHeading(undefined, { reset: true });
		expect(store.headingTypography).toEqual({});
	});

	it('rejects an unknown level and an out-of-range size', () => {
		displayHeading('h7', { size: '20' });
		expect(process.exitCode).toBe(1);
		expect(store.headingTypography).toBeUndefined();

		process.exitCode = undefined;
		displayHeading('h1', { size: 'huge' });
		expect(process.exitCode).toBe(1);
	});

	it('lists all six levels as JSON with the zoom applied', () => {
		store.fontZoom = 1.5;
		store.headingTypography = { h1: { fontFamily: 'Georgia', fontSize: 20 } };
		displayHeading(undefined, { json: true });
		const payload = vi.mocked(emitJsonl).mock.calls[0][0] as {
			headings: Array<{ level: string; fontFamily: string; effectiveSize: number | null }>;
		};
		expect(payload.headings).toHaveLength(6);
		expect(payload.headings[0]).toMatchObject({
			level: 'h1',
			fontFamily: 'Georgia',
			effectiveSize: 30,
		});
		expect(payload.headings[1].effectiveSize).toBeNull();
	});
});
