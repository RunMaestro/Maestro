import { existsSync } from 'fs';
import { join } from 'path';

function runtimeName(): string {
	return process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
}

function platformPackages(): string[] {
	const suffix = `${process.platform}-${process.arch}`;
	return process.platform === 'linux' ? [suffix, `linuxmusl-${process.arch}`] : [suffix];
}

/** Resolve a directly spawnable Copilot runtime without relying on module search paths. */
export function resolveCopilotRuntimeExecutable(
	command: string,
	resourcesPath = process.resourcesPath
): string | undefined {
	if (process.env.MAESTRO_COPILOT_RUNTIME && existsSync(process.env.MAESTRO_COPILOT_RUNTIME)) {
		return process.env.MAESTRO_COPILOT_RUNTIME;
	}
	if (existsSync(command) && !(process.platform === 'win32' && /\.(cmd|bat)$/i.test(command))) {
		return command;
	}
	if (!resourcesPath) return undefined;
	for (const packageName of platformPackages()) {
		for (const appDir of ['app.asar.unpacked', 'app.asar']) {
			const candidate = join(
				resourcesPath,
				appDir,
				'node_modules',
				'@github',
				`copilot-sdk-${packageName}`,
				'prebuilds',
				packageName,
				runtimeName()
			);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}
