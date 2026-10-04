/**
 * Settings domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_settings, set_setting.
 */

import type { SettingValue } from '../../types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import {
	currentComputerHistoryFlag,
	settingsWriteChangesComputerHistory,
} from '../bridgePathGuard';

/**
 * Allowlist of setting keys modifiable from the web interface.
 */
const ALLOWED_SETTING_KEYS = new Set([
	'activeThemeId',
	'customThemeColors',
	'customThemeBaseId',
	'themeGloss',
	'fontSize',
	'enterToSendAI',
	'defaultSaveToHistory',
	'defaultShowThinking',
	'notificationsEnabled',
	'audioFeedbackEnabled',
	'colorBlindMode',
	'conductorProfile',
	'maxOutputLines',
	'encoreFeatures',
]);

/**
 * Handle get_settings message - return current settings
 */
export function handleGetSettings(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (!ctx.callbacks.getSettings) {
		ctx.sendError(client, 'Settings not configured');
		return;
	}

	const settings = ctx.callbacks.getSettings();
	ctx.send(client, {
		type: 'settings',
		settings,
		requestId: message.requestId,
	});
}

/**
 * Handle set_setting message - modify a single setting
 */
export function handleSetSetting(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const key = message.key as string;
	const value = message.value as SettingValue;

	if (!key || typeof key !== 'string') {
		ctx.sendError(client, 'Missing or invalid setting key');
		return;
	}

	if (!ALLOWED_SETTING_KEYS.has(key)) {
		ctx.sendError(client, `Setting key '${key}' is not modifiable from the web interface`);
		return;
	}

	if (value === undefined) {
		ctx.sendError(client, 'Missing setting value');
		return;
	}

	// A browser may not turn Computer History on or off (it records the
	// user's screen). maestro-cli (`client.cli`) may: `encore enable` uses this
	// message. Same rule as the bridge guard for `settings:set`.
	if (
		!client.cli &&
		settingsWriteChangesComputerHistory(key, value, currentComputerHistoryFlag())
	) {
		ctx.sendError(
			client,
			'Computer History can only be turned on or off from the Maestro desktop app or maestro-cli'
		);
		return;
	}

	if (!ctx.callbacks.setSetting) {
		ctx.sendError(client, 'Setting modification not configured');
		return;
	}

	ctx.callbacks
		.setSetting(key, value)
		.then((success) => {
			ctx.send(client, {
				type: 'set_setting_result',
				success,
				key,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to set setting: ${error.message}`);
		});
}
