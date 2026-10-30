import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveCopilotRuntimeExecutable } from '../../../../shared/maestro-lib/providers/copilot-runtime';
import { findPackagedAppHost } from '../../../../shared/maestro-lib/launch/interactive-mode';

const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const runtimeDescriptor = Object.getOwnPropertyDescriptor(process.env, 'MAESTRO_COPILOT_RUNTIME');
const cleanup: string[] = [];

afterEach(() => {
	if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
	else delete process.resourcesPath;
	if (runtimeDescriptor)
		Object.defineProperty(process.env, 'MAESTRO_COPILOT_RUNTIME', runtimeDescriptor);
	else delete process.env.MAESTRO_COPILOT_RUNTIME;
	while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('resolveCopilotRuntimeExecutable', () => {
	it('finds the unpacked platform runtime', () => {
		const root = mkdtempSync(join(tmpdir(), 'copilot-runtime-'));
		cleanup.push(root);
		const suffix = `${process.platform}-${process.arch}`;
		const executable = join(
			root,
			'app.asar.unpacked',
			'node_modules',
			'@github',
			`copilot-sdk-${suffix}`,
			'prebuilds',
			suffix,
			process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime'
		);
		mkdirSync(join(executable, '..'), { recursive: true });
		writeFileSync(executable, '');
		Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true });

		expect(resolveCopilotRuntimeExecutable(join(root, 'missing-copilot'))).toBe(executable);
	});

	it.skipIf(process.platform !== 'win32')(
		'rejects Windows npm wrappers for packaged discovery',
		() => {
			const root = mkdtempSync(join(tmpdir(), 'copilot-runtime-wrapper-'));
			cleanup.push(root);
			const suffix = `${process.platform}-${process.arch}`;
			const executable = join(
				root,
				'app.asar.unpacked',
				'node_modules',
				'@github',
				`copilot-sdk-${suffix}`,
				'prebuilds',
				suffix,
				'copilot-runtime.exe'
			);
			mkdirSync(join(executable, '..'), { recursive: true });
			writeFileSync(executable, '');
			Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true });
			const wrapper = join(root, 'copilot.cmd');
			writeFileSync(wrapper, '');

			expect(resolveCopilotRuntimeExecutable(wrapper)).toBe(executable);
		}
	);

	it('locates packaged resources beside the CLI under system Node', () => {
		const root = mkdtempSync(join(tmpdir(), 'copilot-runtime-host-'));
		cleanup.push(root);
		const resources = join(root, 'resources');
		mkdirSync(resources, { recursive: true });
		writeFileSync(join(resources, 'app.asar'), '');
		const binary =
			process.platform === 'win32'
				? 'Maestro.exe'
				: process.platform === 'darwin'
					? 'MacOS/Maestro'
					: 'maestro';
		writeFileSync(join(root, binary), '');

		expect(findPackagedAppHost(resources)?.resourcesPath).toBe(resources);
	});
	it('honors an explicit runtime override', () => {
		const root = mkdtempSync(join(tmpdir(), 'copilot-runtime-override-'));
		cleanup.push(root);
		const executable = join(root, 'custom-copilot');
		writeFileSync(executable, '');
		process.env.MAESTRO_COPILOT_RUNTIME = executable;
		expect(resolveCopilotRuntimeExecutable('missing')).toBe(executable);
	});
});
