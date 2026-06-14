/**
 * Tests for src/renderer/stores/cueDirtyStore.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useCueDirtyStore } from '../../../renderer/stores/cueDirtyStore';

beforeEach(() => {
	useCueDirtyStore.setState({ pipelineDirty: false, yamlDirty: false, pipelineSaving: false });
});

describe('useCueDirtyStore', () => {
	it('has all flags false initially', () => {
		const { pipelineDirty, yamlDirty, pipelineSaving } = useCueDirtyStore.getState();
		expect(pipelineDirty).toBe(false);
		expect(yamlDirty).toBe(false);
		expect(pipelineSaving).toBe(false);
	});

	it('isAnyDirty() returns false when neither flag is set', () => {
		expect(useCueDirtyStore.getState().isAnyDirty()).toBe(false);
	});

	it('setPipelineDirty(true) sets pipelineDirty and isAnyDirty returns true', () => {
		useCueDirtyStore.getState().setPipelineDirty(true);
		expect(useCueDirtyStore.getState().pipelineDirty).toBe(true);
		expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
	});

	it('setYamlDirty(true) sets yamlDirty and isAnyDirty returns true', () => {
		useCueDirtyStore.getState().setYamlDirty(true);
		expect(useCueDirtyStore.getState().yamlDirty).toBe(true);
		expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
	});

	it('isAnyDirty() is true when only pipeline is dirty', () => {
		useCueDirtyStore.getState().setPipelineDirty(true);
		expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
	});

	it('isAnyDirty() is true when only yaml is dirty', () => {
		useCueDirtyStore.getState().setYamlDirty(true);
		expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
	});

	it('resetAll() clears both flags', () => {
		useCueDirtyStore.getState().setPipelineDirty(true);
		useCueDirtyStore.getState().setYamlDirty(true);

		useCueDirtyStore.getState().resetAll();

		expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);
		expect(useCueDirtyStore.getState().yamlDirty).toBe(false);
		expect(useCueDirtyStore.getState().isAnyDirty()).toBe(false);
	});

	it('setPipelineDirty(false) clears the pipeline flag', () => {
		useCueDirtyStore.getState().setPipelineDirty(true);
		useCueDirtyStore.getState().setPipelineDirty(false);
		expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);
	});

	describe('pipelineSaving', () => {
		it('setPipelineSaving(true) sets the saving flag', () => {
			useCueDirtyStore.getState().setPipelineSaving(true);
			expect(useCueDirtyStore.getState().pipelineSaving).toBe(true);
		});

		it('setPipelineSaving(false) clears the saving flag', () => {
			useCueDirtyStore.getState().setPipelineSaving(true);
			useCueDirtyStore.getState().setPipelineSaving(false);
			expect(useCueDirtyStore.getState().pipelineSaving).toBe(false);
		});

		it('pipelineSaving does not affect isAnyDirty()', () => {
			useCueDirtyStore.getState().setPipelineSaving(true);
			expect(useCueDirtyStore.getState().isAnyDirty()).toBe(false);
		});

		it('resetAll() does NOT clear pipelineSaving (save outlives the modal)', () => {
			useCueDirtyStore.getState().setPipelineDirty(true);
			useCueDirtyStore.getState().setPipelineSaving(true);

			useCueDirtyStore.getState().resetAll();

			expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);
			expect(useCueDirtyStore.getState().pipelineSaving).toBe(true);
		});
	});
});
