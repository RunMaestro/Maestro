import { describe, expect, it, vi } from 'vitest';
import {
	buildDesktopRuntimeDeps,
	type DesktopRuntimeDepsOptions,
} from '../../../main/library-runtime/desktop-deps';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const settings = (values: Record<string, unknown>): DesktopRuntimeDepsOptions['settingsStore'] =>
	({
		get: vi.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
	}) as never;

describe('buildDesktopRuntimeDeps', () => {
	it("reads a new tab's defaults from the settings store at the moment of the call", async () => {
		const values: Record<string, unknown> = {
			defaultSaveToHistory: false,
			defaultShowThinking: 'on',
			newTabPlacement: 'after-current',
		};
		const deps = buildDesktopRuntimeDeps({
			settingsStore: settings(values),
			getProcessManager: () => null,
		});

		await expect(deps.readTabDefaults()).resolves.toEqual({
			saveToHistory: false,
			showThinking: 'on',
			placement: 'after-current',
		});

		values.defaultShowThinking = 'off';
		values.newTabPlacement = 'end';
		await expect(deps.readTabDefaults()).resolves.toMatchObject({
			showThinking: 'off',
			placement: 'end',
		});
	});

	it('falls back to the library defaults for a setting the person never touched', async () => {
		const deps = buildDesktopRuntimeDeps({
			settingsStore: settings({}),
			getProcessManager: () => null,
		});
		await expect(deps.readTabDefaults()).resolves.toEqual({
			saveToHistory: true,
			showThinking: 'off',
			placement: 'end',
		});
	});

	it('answers process questions from the ProcessManager it is given later', () => {
		let manager: {
			get: () => unknown;
			getAll: () => Array<{ sessionId: string }>;
			kill: () => boolean;
		} | null = null;
		const deps = buildDesktopRuntimeDeps({
			settingsStore: settings({}),
			getProcessManager: () => manager,
		});
		expect(deps.processes.isBusy('a1')).toBe(false);

		manager = { get: () => undefined, getAll: () => [{ sessionId: 'a1-ai-t1' }], kill: () => true };
		expect(deps.processes.isBusy('a1')).toBe(true);
	});
});
