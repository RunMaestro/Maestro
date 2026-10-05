import { existsSync } from 'node:fs';
import path from 'node:path';

/** Re-resolve after installation: the running app's PATH may predate the installer. */
export function tailscaleExecutable(): string {
	if (process.platform === 'win32') {
		const installed = path.join(
			process.env.ProgramFiles || 'C:\\Program Files',
			'Tailscale',
			'tailscale.exe'
		);
		if (existsSync(installed)) return installed;
	}
	if (process.platform === 'darwin') {
		const installed = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
		if (existsSync(installed)) return installed;
	}
	return 'tailscale';
}

/** Open only the installed vendor application, never an arbitrary path supplied by a peer. */
export function tailscaleApplication(): string | undefined {
	const application =
		process.platform === 'win32'
			? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale-ipn.exe')
			: process.platform === 'darwin'
				? '/Applications/Tailscale.app'
				: undefined;
	return application && existsSync(application) ? application : undefined;
}

export const tailscaleInstallUrl = () =>
	'https://tailscale.com/download/' +
	(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux');
