/**
 * Web Server Services Index
 *
 * Re-exports all service modules for the web server.
 */

export { BroadcastService } from './broadcastService';
// Split out because everything below is a type: `isolatedModules` compiles each
// file alone, so a type re-exported through a value `export` has no runtime
// binding to emit and is a hard error.
export type {
	WebClientInfo,
	CustomAICommand,
	AITabData,
	SessionBroadcastData,
	AutoRunState,
	CliActivity,
	GetWebClientsCallback,
} from './broadcastService';
