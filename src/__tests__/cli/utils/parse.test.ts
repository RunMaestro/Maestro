import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { parseCliBool, isInheritValue, resolveCliPath } from '../../../cli/utils/parse';

describe('parseCliBool', () => {
	it('accepts the whole true vocabulary', () => {
		for (const word of ['true', '1', 'yes', 'on', 'TRUE', ' Yes ', 'ON']) {
			expect(parseCliBool(word, '--flag')).toBe(true);
		}
	});

	it('accepts the whole false vocabulary', () => {
		for (const word of ['false', '0', 'no', 'off', 'FALSE', ' No ', 'OFF']) {
			expect(parseCliBool(word, '--flag')).toBe(false);
		}
	});

	it('names the offending flag so the caller can report it', () => {
		expect(() => parseCliBool('maybe', '--bookmark')).toThrow(
			'--bookmark expects true or false, got "maybe"'
		);
	});

	it('rejects an empty value rather than defaulting it', () => {
		expect(() => parseCliBool('', '--flag')).toThrow();
	});
});

describe('isInheritValue', () => {
	it('recognizes every word that clears an override', () => {
		for (const word of ['', 'inherit', 'default', 'none', 'clear', 'unset', ' Inherit ']) {
			expect(isInheritValue(word)).toBe(true);
		}
	});

	it('does not treat false as inherit', () => {
		// `--enter-to-send false` pins the tab to Cmd+Enter; `inherit` returns it
		// to the global setting. Conflating them silently changes the behavior.
		for (const word of ['false', 'off', '0', 'opus', 'high']) {
			expect(isInheritValue(word)).toBe(false);
		}
	});
});

describe('resolveCliPath', () => {
	it('expands ~ and makes relative paths absolute against the cwd', () => {
		expect(resolveCliPath('~/out')).toBe(path.join(os.homedir(), 'out'));
		expect(resolveCliPath(' rel/out ')).toBe(path.resolve(process.cwd(), 'rel/out'));
		expect(resolveCliPath('/abs/out')).toBe(path.resolve('/abs/out'));
	});
});
