import { ipcMain } from 'electron';
import type { MaestroRemoteHandshake } from '../../shared/maestroRemote';
import { isDesktopOnlyChannel } from '../ipc/desktop-only-channels';
import type { WebClient } from './types';
import { handleBridgeInvoke } from './handlers/bridgeHandlers';
import { isRemoteEventAllowed, isRemoteMethodAllowed } from './handlers/bridgeDenyList';

type Capabilities = MaestroRemoteHandshake['capabilities'];
type Workflow = keyof Capabilities;

/** Required operations, not a proxy based on a handful of startup handlers. */
export const REMOTE_WORKFLOWS = {
	sessions: {
		methods: [
			'sessions:getBootstrap',
			'sessions:getDeferredContent',
			'sessions:setMany',
			'groups:getAll',
			'groups:setAll',
			'agents:detect',
			'agents:getCapabilities',
			'agents:getConfig',
			'process:spawn',
			'process:cancelCommand',
			'process:interrupt',
			'prompts:getAll',
			'prompts:getSystemPromptPaths',
			'settings:getAll',
			'settings:set',
			'web:requestNewTab',
			'web:requestCloseTab',
			'web:requestReopenTab',
			'git:status',
			'git:diff',
			'git:runCommand',
			'autorun:listDocs',
			'autorun:readDoc',
			'autorun:writeDoc',
			'web:startAutoRun',
			'web:controlAutoRun',
			'web:getAutoRunStates',
		],
		events: [
			'sessions:lifecycleSync',
			'sessions:transcriptSync',
			'settings:externalChange',
			'process:data',
			'process:exit',
			'process:command-exit',
			'process:usage',
			'process:permission-request',
			'remote:autoRunStateMirror',
			'autorun:statusChanged',
			'git:commandOutput',
		],
	},
	terminal: {
		methods: [
			'process:spawnTerminalTab',
			'process:write',
			'process:resize',
			'process:kill',
			'process:getActiveProcesses',
		],
		events: ['process:data', 'process:exit'],
	},
	files: {
		methods: [
			'fs:homeDir',
			'fs:directoryInfo',
			'fs:readDir',
			'fs:readFile',
			'fs:writeFile',
			'attachments:save',
			'attachments:load',
		],
		events: [],
	},
	browserRelay: {
		methods: [
			'browser:relayOpen',
			'browser:relayFrame',
			'browser:relayInput',
			'browser:relayAction',
			'browser:relayClose',
		],
		events: [],
	},
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const READ_PROBES: Partial<
	Record<Workflow, Array<{ channel: string; accepts: (value: unknown) => boolean }>>
> = {
	sessions: [
		{ channel: 'sessions:getBootstrap', accepts: Array.isArray },
		{ channel: 'groups:getAll', accepts: Array.isArray },
		{ channel: 'web:getAutoRunStates', accepts: record },
		{ channel: 'settings:getAll', accepts: record },
		{
			channel: 'prompts:getSystemPromptPaths',
			accepts: (value) =>
				record(value) && value.success === true && typeof value.computerHistoryDir === 'string',
		},
	],
	terminal: [{ channel: 'process:getActiveProcesses', accepts: Array.isArray }],
	files: [
		{ channel: 'fs:homeDir', accepts: (value) => typeof value === 'string' && value.length > 0 },
	],
};

const probesInFlight = new Map<string, Promise<boolean>>();
function probeRead(
	client: Pick<WebClient, 'id' | 'user' | 'cli'>,
	channel: string,
	accepts: (value: unknown) => boolean
): Promise<boolean> {
	const existing = probesInFlight.get(channel);
	if (existing) return existing;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	probesInFlight.set(channel, promise);
	let settled = false;
	const finish = (result: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (probesInFlight.get(channel) === promise) probesInFlight.delete(channel);
		resolve(result);
	};
	const timer = setTimeout(() => finish(false), 3000);
	// Use the real dispatcher, including acting-user attribution, path guards,
	// desktop-only restrictions and result filtering. Never probe a mutation.
	void handleBridgeInvoke(
		client,
		{ type: 'bridge.invoke', requestId: channel, channel, args: [] },
		(_client, payload) => finish(record(payload) && payload.ok === true && accepts(payload.result))
	).catch(() => finish(false));
	return promise;
}

export async function qualifyRemoteWorkflows(
	available: Capabilities,
	client: Pick<WebClient, 'id' | 'user' | 'cli'>
): Promise<{ capabilities: Capabilities; failures: string[]; temporarilyUnavailable: boolean }> {
	const capabilities = { sessions: false, terminal: false, files: false, browserRelay: false };
	const failures: string[] = [];
	let temporarilyUnavailable = false;
	let incompatible = !available.sessions || !available.terminal || !available.files;
	const rawHandlers = Reflect.get(ipcMain, '_invokeHandlers');
	const handlers = rawHandlers instanceof Map ? rawHandlers : undefined;
	await Promise.all(
		(Object.keys(REMOTE_WORKFLOWS) as Workflow[]).map(async (workflow) => {
			if (!available[workflow]) return;
			const inventory = REMOTE_WORKFLOWS[workflow];
			const missing = [
				...inventory.methods.filter(
					(channel) =>
						!isRemoteMethodAllowed(channel) ||
						isDesktopOnlyChannel(channel) ||
						!(handlers?.has(channel) || ipcMain.listenerCount(channel) > 0)
				),
				...inventory.events.filter(
					(channel) => !isRemoteEventAllowed(channel) || isDesktopOnlyChannel(channel)
				),
			];
			if (missing.length) {
				if (workflow !== 'browserRelay') incompatible = true;
				failures.push(workflow + ' unavailable: ' + missing.join(', '));
				return;
			}
			const reads = READ_PROBES[workflow] ?? [];
			const results = await Promise.all(
				reads.map((probe) => probeRead(client, probe.channel, probe.accepts))
			);
			const failed = reads.filter((_probe, index) => !results[index]).map((probe) => probe.channel);
			if (failed.length) {
				temporarilyUnavailable = true;
				failures.push(workflow + ' read checks failed: ' + failed.join(', '));
			} else capabilities[workflow] = true;
		})
	);
	return {
		capabilities,
		failures: failures.sort(),
		temporarilyUnavailable: temporarilyUnavailable && !incompatible,
	};
}
