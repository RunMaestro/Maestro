import { describe, expect, it } from 'vitest';
import { parseTuiArgs } from '../args';

describe('parseTuiArgs', () => {
	it('defaults to no flags', () => {
		expect(parseTuiArgs([])).toEqual({ dev: false, doctor: false });
	});

	it('reads --dev and --doctor', () => {
		expect(parseTuiArgs(['--dev', '--doctor'])).toEqual({ dev: true, doctor: true });
	});

	it('reads --data-dir in both spellings', () => {
		expect(parseTuiArgs(['--data-dir', '/a']).dataDir).toBe('/a');
		expect(parseTuiArgs(['--data-dir=/b']).dataDir).toBe('/b');
	});
});
