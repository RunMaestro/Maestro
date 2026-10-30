import { existsSync } from 'fs';
import { delimiter, dirname, join } from 'path';

export interface HermesGatewayLaunchConfig {
	command: string;
	args?: string[];
	customEnvVars?: Record<string, string>;
}

/** Resolve Hermes' headless gateway independently of its interactive `hermes --tui` launcher. */
export function resolveHermesGatewayLaunch<T extends HermesGatewayLaunchConfig>(config: T): T {
	if (config.args?.includes('tui_gateway.entry')) return config;
	const command = config.command ?? '';
	const installRoot = /[\\/]bin[\\/][^\\/]+$/.test(command) ? dirname(dirname(command)) : '';
	const profileDir =
		config.customEnvVars?.HERMES_HOME ||
		(installRoot ? join(installRoot, 'hermes-agent') : '') ||
		process.env.HERMES_HOME ||
		'';
	if (!profileDir) {
		throw new Error('Cannot locate the Hermes profile for native gateway mode');
	}
	const python = join(
		profileDir,
		'venv',
		process.platform === 'win32' ? 'Scripts' : 'bin',
		process.platform === 'win32' ? 'python.exe' : 'python'
	);
	if (!existsSync(python)) {
		throw new Error(`Hermes gateway Python was not found at ${python}`);
	}
	return {
		...config,
		command: python,
		args: ['-m', 'tui_gateway.entry'],
		customEnvVars: {
			...config.customEnvVars,
			HERMES_HOME: profileDir,
			PYTHONPATH: [profileDir, config.customEnvVars?.PYTHONPATH, process.env.PYTHONPATH]
				.filter(Boolean)
				.join(delimiter),
		},
	};
}
