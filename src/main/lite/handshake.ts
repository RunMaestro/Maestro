import { MAESTRO_REMOTE_PROTOCOL_VERSION } from '../../shared/maestroRemote';
import type { MaestroRemoteHandshake } from '../../shared/maestroRemote';
import type { LiteProfile } from './profiles';

export class HostConnectionError extends Error {
	name = 'HostConnectionError';
}

export function validateHandshake(
	value: unknown,
	profile: LiteProfile,
	devicePaired = false
): MaestroRemoteHandshake {
	const host = value as MaestroRemoteHandshake;
	if (
		!host ||
		host.protocolVersion !== MAESTRO_REMOTE_PROTOCOL_VERSION ||
		typeof host.instanceId !== 'string' ||
		!host.instanceId ||
		typeof host.hostName !== 'string' ||
		typeof host.appVersion !== 'string' ||
		typeof host.platform !== 'string' ||
		typeof host.ready !== 'boolean' ||
		!host.authentication ||
		typeof host.authentication.authenticated !== 'boolean' ||
		typeof host.authentication.loginEnabled !== 'boolean' ||
		!host.capabilities ||
		[
			host.capabilities.sessions,
			host.capabilities.terminal,
			host.capabilities.files,
			host.capabilities.browserRelay,
		].some((capability) => typeof capability !== 'boolean')
	)
		throw new HostConnectionError(
			'Incompatible Maestro host. Update the host and Lite to a compatible version.'
		);
	if (profile.instanceId && profile.instanceId !== host.instanceId)
		throw new HostConnectionError(
			'Host identity changed. Disconnect and verify the host before explicitly forgetting the saved identity.'
		);
	if (devicePaired) {
		if (host.authentication.method !== 'device-pairing' || !host.authentication.authenticated)
			throw new HostConnectionError(
				'Paired-device authorization was rejected. Pair this device again.'
			);
	} else {
		if (profile.transport === 'https' && !host.authentication.loginEnabled)
			throw new HostConnectionError(
				'Direct manual HTTPS requires host login. Use device pairing for code-only access.'
			);
		if (host.authentication.loginEnabled && !host.authentication.authenticated)
			throw new HostConnectionError('Host login is required.');
	}
	if (!host.ready)
		throw new HostConnectionError(
			`Host is not ready: ${host.unavailableReason || 'keep full Maestro and its owning window running.'}`
		);
	if (!host.capabilities.sessions || !host.capabilities.terminal || !host.capabilities.files)
		throw new HostConnectionError(
			'Host does not support the required Lite session, terminal, and file workflows.'
		);
	return host;
}
