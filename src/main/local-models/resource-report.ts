/**
 * What Local Models costs this computer: the disk its models, runtimes, model
 * server and semantic index occupy, which models are resident inside the main
 * process, and the model server's own process tree.
 *
 * Reads only. Nothing here loads a model, opens the embedding database, starts
 * the server, or asks the shared engines to create anything they would not
 * already have: the in-process getters report what is resident and stop there.
 */

import { getLocalModel } from '../../shared/local-models/model-catalog';
import type { AppStatsModelOnDisk, LocalModelResources } from '../../shared/appStats';
import { directoryBytes } from '../utils/directory-size';
import { getEmbeddingStore } from './embedding-store';
import { totalFootprint } from './model-store';
import { getOnnxEncoderPool } from './onnx-encoder';
import { runtimesFootprint } from './runtime/runtime-store';
import { serverEngineDir } from './server/engine-store';
import { getModelServerStatus, modelServerDir } from './server/supervisor';
import { getSpeechToTextPool } from './speech-to-text';
import { getLocalTextEngine } from './text-gen';

/** Name a model directory the way the Library does, falling back to its id. */
function describeModelDir(id: string, bytes: number): AppStatsModelOnDisk {
	const entry = getLocalModel(id);
	return {
		id,
		name: entry?.displayName ?? id,
		kind: entry?.kind ?? null,
		bytes,
		userAdded: entry?.userAdded === true,
	};
}

/**
 * Disk, residency and the model server's state. `modelServer.usage` is left
 * null: measuring it needs the process table, and the caller reads that once
 * for the agents and the server together (see `collectAppStats()`).
 */
export async function collectLocalModelResources(): Promise<LocalModelResources> {
	const [footprint, runtimesBytes, serverEngineBytes, serverDataBytes, semanticIndexBytes, server] =
		await Promise.all([
			totalFootprint(),
			runtimesFootprint(),
			directoryBytes(serverEngineDir()),
			directoryBytes(modelServerDir()),
			getEmbeddingStore().diskUsageBytes(),
			getModelServerStatus(),
		]);

	const models = footprint.models
		.map((model) => describeModelDir(model.id, model.bytes))
		.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

	// Only a server the supervisor holds counts; a pid from a previous run is
	// someone else's process by now.
	const pid = server.pid && server.state !== 'stopped' ? server.pid : null;

	return {
		disk: {
			// The engine lives under the runtimes root, so it is already in
			// `runtimesBytes` and is not added twice.
			totalBytes: footprint.bytes + runtimesBytes + serverDataBytes + semanticIndexBytes,
			modelsBytes: footprint.bytes,
			runtimesBytes,
			serverEngineBytes,
			serverDataBytes,
			semanticIndexBytes,
			models,
		},
		inProcess: {
			textModel: getLocalTextEngine().loadedModelId,
			encoders: [...getOnnxEncoderPool().loadedModelIds],
			speechToText: [...getSpeechToTextPool().loadedModelIds],
		},
		modelServer: {
			state: server.state,
			pid,
			port: server.port,
			models: server.models,
			loadedModels: server.loadedModels,
			startedAt: server.startedAt,
			usage: null,
		},
	};
}
