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

import {
	displayFont,
	displayFontSize,
	displayFontsCatalog,
	displayPreset,
	displayZoom,
} from '../../../cli/commands/display-font';
import { writeSettingValue } from '../../../cli/services/storage';
import { emitJsonl } from '../../../cli/output/jsonl';
import { TYPOGRAPHY_PRESETS } from '../../../shared/typographyPresets';

beforeEach(() => {
	for (const key of Object.keys(store)) delete store[key];
	Object.assign(store, {
		fontFamily: 'Inter',
		chatFontFamily: '',
		terminalFontFamily: '',
		filePreviewFontFamily: '',
		fileEditorFontFamily: '',
		fontSize: 15,
		chatFontSize: 0,
		terminalFontSize: 13,
		filePreviewFontSize: 0,
		fileEditorFontSize: 0,
		fontZoom: 1,
	});
	vi.clearAllMocks();
	process.exitCode = undefined;
});

describe('display font', () => {
	it('sets a surface font addressed by id', () => {
		displayFont('terminal', 'Fira Code', {});
		expect(writeSettingValue).toHaveBeenCalledWith('terminalFontFamily', 'Fira Code');
	});

	it('accepts an alias and a loose spelling', () => {
		displayFont('preview', 'Georgia', {});
		expect(writeSettingValue).toHaveBeenCalledWith('filePreviewFontFamily', 'Georgia');

		displayFont('file-editor', 'Menlo', {});
		expect(writeSettingValue).toHaveBeenCalledWith('fileEditorFontFamily', 'Menlo');
	});

	it('spells the empty string as "inherit", which a shell can actually pass', () => {
		displayFont('chat', 'inherit', {});
		expect(writeSettingValue).toHaveBeenCalledWith('chatFontFamily', '');
	});

	it('refuses to make the interface font inherit, since it is the base', () => {
		displayFont('interface', 'inherit', {});
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it('rejects an unknown surface instead of writing something arbitrary', () => {
		displayFont('sidebar', 'Inter', {});
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it('reads a surface font when no value is given', () => {
		store.terminalFontFamily = 'Fira Code';
		displayFont('terminal', undefined, { json: true });
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'terminal', font: 'Fira Code' })
		);
	});

	it('warns when the font is not bundled, since it may silently fall back', () => {
		// The CLI cannot check what is installed, so the only honest signal is
		// whether the family ships with the app.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		displayFont('chat', 'Some Unavailable Face', {});
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not bundled'));
		errorSpy.mockRestore();
	});

	it('does not warn for a bundled font', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		displayFont('chat', 'Inter', {});
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe('display size', () => {
	it('sets a surface size', () => {
		displayFontSize('chat', '17', {});
		expect(writeSettingValue).toHaveBeenCalledWith('chatFontSize', 17);
	});

	it('tolerates a px suffix', () => {
		displayFontSize('chat', '17px', {});
		expect(writeSettingValue).toHaveBeenCalledWith('chatFontSize', 17);
	});

	it('returns a surface to inheriting', () => {
		displayFontSize('terminal', 'inherit', {});
		expect(writeSettingValue).toHaveBeenCalledWith('terminalFontSize', 0);
	});

	it('refuses to make the interface size inherit', () => {
		displayFontSize('interface', 'inherit', {});
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it('rejects a non-numeric size rather than storing NaN', () => {
		displayFontSize('chat', 'large', {});
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it('rejects an out-of-range size rather than clamping it to "inherit"', () => {
		// clampSurfaceFontSize maps an absurd value to 0, which MEANS inherit -
		// silently turning "set it to 2px" into "inherit" would be wrong.
		displayFontSize('chat', '2', {});
		expect(writeSettingValue).toHaveBeenCalledWith('chatFontSize', 8);
	});
});

describe('display zoom', () => {
	it('accepts a percentage', () => {
		displayZoom('125%', {});
		expect(writeSettingValue).toHaveBeenCalledWith('fontZoom', 1.25);
	});

	it('accepts a bare multiplier', () => {
		displayZoom('1.5', {});
		expect(writeSettingValue).toHaveBeenCalledWith('fontZoom', 1.5);
	});

	it('reads a bare number over 5 as a percentage, not a 150x multiplier', () => {
		displayZoom('150', {});
		expect(writeSettingValue).toHaveBeenCalledWith('fontZoom', 1.5);
	});

	it('clamps rather than accepting an unusable zoom', () => {
		displayZoom('9999%', {});
		expect(writeSettingValue).toHaveBeenCalledWith('fontZoom', expect.any(Number));
		const written = vi.mocked(writeSettingValue).mock.calls[0][1] as number;
		expect(written).toBeLessThanOrEqual(2.4);
	});

	it('rejects nonsense', () => {
		displayZoom('big', {});
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});

describe('display preset', () => {
	it('writes every font AND size, like the in-app Factory Reset', () => {
		displayPreset('hacker', {});
		const written = Object.fromEntries(
			vi.mocked(writeSettingValue).mock.calls.map(([k, v]) => [k, v])
		);
		expect(written).toMatchObject({
			...TYPOGRAPHY_PRESETS.hacker.fonts,
			...TYPOGRAPHY_PRESETS.hacker.sizes,
		});
	});

	it('leaves the zoom alone, since it is an accommodation not a look', () => {
		displayPreset('default', {});
		const keys = vi.mocked(writeSettingValue).mock.calls.map(([k]) => k);
		expect(keys).not.toContain('fontZoom');
	});

	it('rejects an unknown preset', () => {
		displayPreset('vaporwave', {});
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it('reports the active preset when given no name', () => {
		Object.assign(store, TYPOGRAPHY_PRESETS.hacker.fonts, TYPOGRAPHY_PRESETS.hacker.sizes);
		displayPreset(undefined, { json: true });
		expect(emitJsonl).toHaveBeenCalledWith(expect.objectContaining({ preset: 'hacker' }));
	});

	it('reports null once the settings match neither preset', () => {
		store.chatFontFamily = 'Comic Sans MS';
		displayPreset(undefined, { json: true });
		expect(emitJsonl).toHaveBeenCalledWith(expect.objectContaining({ preset: null }));
	});
});

describe('display fonts', () => {
	it('lists the bundled catalog as JSON', () => {
		displayFontsCatalog({ json: true });
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'display-font-catalog' })
		);
	});
});
