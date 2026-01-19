/**
 * System Info Collector
 *
 * Collects OS, hardware, and app version information.
 * No sensitive data is collected here.
 */

import os from 'os';
import { app } from 'electron';

export interface SystemInfo {
	os: {
		platform: string;
		release: string;
		arch: string;
		version: string;
	};
	hardware: {
		cpus: number;
		totalMemoryMB: number;
		freeMemoryMB: number;
	};
	app: {
		version: string;
		electronVersion: string;
		nodeVersion: string;
		chromeVersion: string;
	};
	runtime: {
		uptimeSeconds: number;
		appUptimeSeconds: number;
	};
}

/**
 * Collect system information.
 * All data here is non-sensitive system metadata.
 */
export function collectSystemInfo(): SystemInfo {
	return {
		os: {
			platform: os.platform(),
			release: os.release(),
			arch: os.arch(),
			version: os.version(),
		},
		hardware: {
			cpus: os.cpus().length,
			totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
			freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
		},
		app: {
			version: app.getVersion(),
			electronVersion: process.versions.electron || 'unknown',
			nodeVersion: process.versions.node,
			chromeVersion: process.versions.chrome || 'unknown',
		},
		runtime: {
			uptimeSeconds: Math.round(os.uptime()),
			appUptimeSeconds: Math.round(process.uptime()),
		},
	};
}
