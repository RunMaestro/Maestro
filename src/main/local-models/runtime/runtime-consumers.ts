/**
 * Which features actually run on each native runtime.
 *
 * A runtime can be fetchable and still useless: llama.cpp downloads, but if no
 * feature in this build can use it, calling it "not downloaded yet" leaves every
 * self-test permanently incomplete, nagging for a download that enables nothing.
 * Only a consumer knows what it can run, so the core asks instead of guessing:
 * each consumer (A Cappella today) registers once at startup, and the loader
 * reads the union.
 *
 * A registration also says WHERE in the UI that consumer's runtimes are
 * downloaded and self-tested, so a refusal can name a real place rather than a
 * path the core would otherwise have to hard-code for one feature.
 */

import type { NativeRuntimeId } from '../../../shared/local-models/native-runtimes';

export interface NativeRuntimeConsumer {
	/** Stable id, so registering again replaces rather than duplicates. */
	readonly id: string;
	/** Whether anything this consumer offers in this build runs on the runtime. */
	usesRuntime(runtimeId: NativeRuntimeId): boolean;
	/** Where the user downloads the runtime, e.g. `Settings > Models > Library > Engines`. */
	readonly downloadLocation: string;
	/** Where the user runs the runtime self-test. */
	readonly selfTestLocation: string;
}

const consumers = new Map<string, NativeRuntimeConsumer>();

/**
 * Register a consumer. Idempotent by id. Returns an unregister function for
 * tests; production registrations live for the life of the app.
 */
export function registerNativeRuntimeConsumer(consumer: NativeRuntimeConsumer): () => void {
	consumers.set(consumer.id, consumer);
	return () => {
		if (consumers.get(consumer.id) === consumer) consumers.delete(consumer.id);
	};
}

/** The first registered consumer that runs on this runtime, or null when none does. */
export function nativeRuntimeConsumerFor(runtimeId: NativeRuntimeId): NativeRuntimeConsumer | null {
	for (const consumer of consumers.values()) {
		if (consumer.usesRuntime(runtimeId)) return consumer;
	}
	return null;
}

/**
 * Where a person downloads and verifies models that run on this runtime, for
 * recovery sentences. Every refusal (text generation, the ONNX encoders, task
 * readiness) names the same place by asking here.
 */
export function runtimeSetupLocation(runtimeId: NativeRuntimeId): string {
	return nativeRuntimeConsumerFor(runtimeId)?.downloadLocation ?? 'Settings';
}

/** Whether any registered consumer runs on this runtime. */
export function isNativeRuntimeInUse(runtimeId: NativeRuntimeId): boolean {
	return nativeRuntimeConsumerFor(runtimeId) !== null;
}

/** Forget every registration. Tests only. */
export function __resetNativeRuntimeConsumers(): void {
	consumers.clear();
}
