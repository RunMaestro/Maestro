import { describe, it, expect } from 'vitest';

import { getPanelMode } from '../panelModes';

describe('getPanelMode', () => {
	describe('phone tier', () => {
		it('puts both panels in overlay regardless of open state', () => {
			expect(getPanelMode('phone', false, false)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
			expect(getPanelMode('phone', true, false)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
			expect(getPanelMode('phone', false, true)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
			expect(getPanelMode('phone', true, true)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
		});
	});

	describe('desktop tier', () => {
		it('puts both panels inline regardless of open state', () => {
			expect(getPanelMode('desktop', false, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
			expect(getPanelMode('desktop', true, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
			expect(getPanelMode('desktop', false, true)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
			expect(getPanelMode('desktop', true, true)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
		});
	});

	describe('tablet tier', () => {
		it('prefers left inline and right overlay when both panels are open', () => {
			expect(getPanelMode('tablet', true, true)).toEqual({
				leftMode: 'inline',
				rightMode: 'overlay',
			});
		});

		it('gives the inline slot to the right panel when only it is open', () => {
			expect(getPanelMode('tablet', false, true)).toEqual({
				leftMode: 'overlay',
				rightMode: 'inline',
			});
		});

		it('gives the inline slot to the left panel when only it is open', () => {
			expect(getPanelMode('tablet', true, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'overlay',
			});
		});

		it('defaults to left inline / right overlay when neither panel is open', () => {
			expect(getPanelMode('tablet', false, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'overlay',
			});
		});
	});
});
