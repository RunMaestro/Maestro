import { parentPort, workerData } from 'node:worker_threads';
import type Store from 'electron-store';
import { registerSessionStorage } from '../agents/session-storage';
import { ClaudeSessionStorage } from '../storage/claude-session-storage';
import { CodexSessionStorage } from '../storage/codex-session-storage';
import { CopilotSessionStorage } from '../storage/copilot-session-storage';
import { OpenCodeSessionStorage } from '../storage/opencode-session-storage';
import { FactoryDroidSessionStorage } from '../storage/factory-droid-session-storage';
import { OmpSessionStorage } from '../storage/omp-session-storage';
import { GrokSessionStorage } from '../storage/grok-session-storage';
import type { ClaudeSessionOriginsData } from '../storage/claude-session-storage';
import type { MemoryRequest } from '../../shared/pianola/memory';
import { MemoryEngine } from './memory-engine';

// Transcript normalization does not use origin mutations. Keep Electron Store out of the Node worker.
const origins = {
	get: () => ({}),
	set: () => {
		throw new Error('Historical ingestion cannot mutate provider metadata');
	},
} as unknown as Store<ClaudeSessionOriginsData>;
for (const reader of [
	new ClaudeSessionStorage(origins),
	new CodexSessionStorage(),
	new CopilotSessionStorage(),
	new OpenCodeSessionStorage(),
	new FactoryDroidSessionStorage(),
	new OmpSessionStorage(),
	new GrokSessionStorage(),
])
	registerSessionStorage(reader);
let featureEnabled = workerData.featureEnabled !== false;
const engine = new MemoryEngine(workerData.directory, () => featureEnabled);
let operations = Promise.resolve();
parentPort?.on(
	'message',
	(message: { featureEnabled: boolean } | { id: number; request: MemoryRequest }) => {
		if ('featureEnabled' in message) {
			featureEnabled = message.featureEnabled;
			return;
		}
		operations = operations.then(async () => {
			try {
				const result = await engine.request(message.request);
				if (message.request.action === 'configure' && engine.database.config().enabled)
					await engine.migrateProfiles();
				parentPort?.postMessage({ id: message.id, result });
			} catch (error) {
				parentPort?.postMessage({
					id: message.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}
);
if (
	engine.database.config().enabled &&
	!engine.database.get<boolean>('paused') &&
	engine.database.transport.ready(engine.transportOwner)
)
	engine.start();
