/**
 * @file parkedRecords.test.ts
 * @description Tests for the two-record parking helpers.
 *
 * The invariant under test throughout: a key lives in exactly ONE of the two
 * records. A key in both is unreachable state - re-enabling the parked copy
 * after deleting the live one silently restores a value the user cannot see.
 */

import { describe, it, expect } from 'vitest';
import {
	parkedPairKeys,
	setKeysParked,
	splitParkedEntries,
	type ParkedRecordPair,
} from '../../shared/parkedRecords';

describe('splitParkedEntries', () => {
	it('returns undefined for both halves when there is nothing to store', () => {
		expect(splitParkedEntries([])).toEqual({ active: undefined, parked: undefined });
	});

	it('sorts entries by their enabled flag', () => {
		expect(
			splitParkedEntries([
				{ key: 'ConnectTimeout', value: '45', enabled: true },
				{ key: 'ProxyCommand', value: 'tailcat tcABC 22', enabled: false },
			])
		).toEqual({
			active: { ConnectTimeout: '45' },
			parked: { ProxyCommand: 'tailcat tcABC 22' },
		});
	});

	it('drops a blank key and trims the rest', () => {
		expect(
			splitParkedEntries([
				{ key: '  ProxyJump  ', value: 'bastion', enabled: true },
				{ key: '   ', value: 'orphan', enabled: true },
			]).active
		).toEqual({ ProxyJump: 'bastion' });
	});

	it('keeps a blank value, which is meaningful for some options', () => {
		expect(splitParkedEntries([{ key: 'ProxyCommand', value: '', enabled: true }]).active).toEqual({
			ProxyCommand: '',
		});
	});

	it('gives a live row the key outright when both spellings are present', () => {
		// Two rows can share a key mid-edit. Landing in both records would make
		// the parked copy invisible but resurrectable, so the live row wins.
		const { active, parked } = splitParkedEntries([
			{ key: 'ConnectTimeout', value: '10', enabled: false },
			{ key: 'ConnectTimeout', value: '45', enabled: true },
		]);
		expect(active).toEqual({ ConnectTimeout: '45' });
		expect(parked).toBeUndefined();
	});

	it('holds that rule whichever order the rows are in', () => {
		const { active, parked } = splitParkedEntries([
			{ key: 'ConnectTimeout', value: '45', enabled: true },
			{ key: 'ConnectTimeout', value: '10', enabled: false },
		]);
		expect(active).toEqual({ ConnectTimeout: '45' });
		expect(parked).toBeUndefined();
	});
});

describe('setKeysParked', () => {
	const pair: ParkedRecordPair = {
		active: { ConnectTimeout: '45', ProxyJump: 'bastion' },
		parked: { ProxyCommand: 'tailcat tcABC 22' },
	};

	it('moves a key out of the active record, keeping its value', () => {
		const next = setKeysParked(pair, ['ProxyJump'], true);
		expect(next.active).toEqual({ ConnectTimeout: '45' });
		expect(next.parked).toEqual({
			ProxyCommand: 'tailcat tcABC 22',
			ProxyJump: 'bastion',
		});
	});

	it('moves a key back into the active record', () => {
		const next = setKeysParked(pair, ['ProxyCommand'], false);
		expect(next.active).toEqual({
			ConnectTimeout: '45',
			ProxyJump: 'bastion',
			ProxyCommand: 'tailcat tcABC 22',
		});
		expect(next.parked).toBeUndefined();
	});

	it('ignores a key that is in neither record rather than inventing it', () => {
		// Disabling something already deleted must be a no-op, not a resurrection
		// of an empty value under that name.
		const next = setKeysParked(pair, ['NoSuchOption'], true);
		expect(next).toEqual(pair);
	});

	it('is a no-op when the key is already on the requested side', () => {
		expect(setKeysParked(pair, ['ProxyCommand'], true)).toEqual(pair);
	});

	it('does not mutate the pair it was given', () => {
		const original = JSON.parse(JSON.stringify(pair));
		setKeysParked(pair, ['ProxyJump'], true);
		expect(pair).toEqual(original);
	});

	it('collapses an emptied record to undefined', () => {
		const next = setKeysParked({ active: { ProxyJump: 'bastion' } }, ['ProxyJump'], true);
		expect(next.active).toBeUndefined();
		expect(next.parked).toEqual({ ProxyJump: 'bastion' });
	});

	it('handles several keys in one call', () => {
		const next = setKeysParked(pair, ['ConnectTimeout', 'ProxyJump'], true);
		expect(next.active).toBeUndefined();
		expect(Object.keys(next.parked ?? {}).sort()).toEqual([
			'ConnectTimeout',
			'ProxyCommand',
			'ProxyJump',
		]);
	});
});

describe('parkedPairKeys', () => {
	it('lists active keys before parked ones', () => {
		expect(parkedPairKeys({ active: { A: '1', B: '2' }, parked: { C: '3' } })).toEqual([
			'A',
			'B',
			'C',
		]);
	});

	it('returns nothing for an empty pair', () => {
		expect(parkedPairKeys({})).toEqual([]);
	});
});
