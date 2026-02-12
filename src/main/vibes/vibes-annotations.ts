// VIBES v1.0 Annotation Builder — Constructs properly-formatted VIBES annotations
// from Maestro's internal event data. Each builder function returns a typed entry
// along with its content-addressed hash for manifest storage.

import { gzipSync } from 'zlib';
import { computeVibesHash } from './vibes-hash';
import type {
	VibesAssuranceLevel,
	VibesAction,
	VibesCommandType,
	VibesPromptType,
	VibesEnvironmentEntry,
	VibesCommandEntry,
	VibesPromptEntry,
	VibesReasoningEntry,
	VibesLineAnnotation,
	VibeFunctionAnnotation,
	VibesSessionRecord,
} from '../../shared/vibes-types';

// ============================================================================
// Environment Entry
// ============================================================================

/**
 * Create an environment manifest entry recording the tool/model that produced annotations.
 * Returns the entry and its content-addressed hash.
 */
export function createEnvironmentEntry(params: {
	toolName: string;
	toolVersion: string;
	modelName: string;
	modelVersion: string;
	modelParameters?: Record<string, unknown>;
	toolExtensions?: string[];
}): { entry: VibesEnvironmentEntry; hash: string } {
	const entry: VibesEnvironmentEntry = {
		type: 'environment',
		tool_name: params.toolName,
		tool_version: params.toolVersion,
		model_name: params.modelName,
		model_version: params.modelVersion,
		created_at: new Date().toISOString(),
	};

	if (params.modelParameters !== undefined) {
		entry.model_parameters = params.modelParameters;
	}
	if (params.toolExtensions !== undefined) {
		entry.tool_extensions = params.toolExtensions;
	}

	const hash = computeVibesHash(entry as unknown as Record<string, unknown>);
	return { entry, hash };
}

// ============================================================================
// Command Entry
// ============================================================================

/**
 * Create a command manifest entry recording a command executed by the agent.
 * Returns the entry and its content-addressed hash.
 */
export function createCommandEntry(params: {
	commandText: string;
	commandType: VibesCommandType;
	exitCode?: number;
	outputSummary?: string;
	workingDirectory?: string;
}): { entry: VibesCommandEntry; hash: string } {
	const entry: VibesCommandEntry = {
		type: 'command',
		command_text: params.commandText,
		command_type: params.commandType,
		created_at: new Date().toISOString(),
	};

	if (params.exitCode !== undefined) {
		entry.command_exit_code = params.exitCode;
	}
	if (params.outputSummary !== undefined) {
		entry.command_output_summary = params.outputSummary;
	}
	if (params.workingDirectory !== undefined) {
		entry.working_directory = params.workingDirectory;
	}

	const hash = computeVibesHash(entry as unknown as Record<string, unknown>);
	return { entry, hash };
}

// ============================================================================
// Prompt Entry
// ============================================================================

/**
 * Create a prompt manifest entry recording a prompt that triggered agent activity.
 * Only captured at Medium+ assurance levels.
 * Returns the entry and its content-addressed hash.
 */
export function createPromptEntry(params: {
	promptText: string;
	promptType?: VibesPromptType;
	contextFiles?: string[];
}): { entry: VibesPromptEntry; hash: string } {
	const entry: VibesPromptEntry = {
		type: 'prompt',
		prompt_text: params.promptText,
		created_at: new Date().toISOString(),
	};

	if (params.promptType !== undefined) {
		entry.prompt_type = params.promptType;
	}
	if (params.contextFiles !== undefined) {
		entry.prompt_context_files = params.contextFiles;
	}

	const hash = computeVibesHash(entry as unknown as Record<string, unknown>);
	return { entry, hash };
}

// ============================================================================
// Reasoning Entry
// ============================================================================

/**
 * Create a reasoning manifest entry recording chain-of-thought output from the model.
 * Only captured at High assurance level.
 *
 * When reasoning text exceeds `compressThresholdBytes` (default 10 KB), the text
 * is gzip-compressed and base64-encoded into `reasoning_text_compressed`, with
 * `compressed` set to true and raw `reasoning_text` omitted to save space.
 *
 * Returns the entry and its content-addressed hash.
 */
export function createReasoningEntry(params: {
	reasoningText: string;
	tokenCount?: number;
	model?: string;
	compressThresholdBytes?: number;
}): { entry: VibesReasoningEntry; hash: string } {
	const compressThreshold = params.compressThresholdBytes ?? 10240;
	const textBytes = Buffer.byteLength(params.reasoningText, 'utf8');

	const entry: VibesReasoningEntry = {
		type: 'reasoning',
		created_at: new Date().toISOString(),
	};

	if (textBytes > compressThreshold) {
		const compressed = gzipSync(Buffer.from(params.reasoningText, 'utf8'));
		entry.reasoning_text_compressed = compressed.toString('base64');
		entry.compressed = true;
	} else {
		entry.reasoning_text = params.reasoningText;
	}

	if (params.tokenCount !== undefined) {
		entry.reasoning_token_count = params.tokenCount;
	}
	if (params.model !== undefined) {
		entry.reasoning_model = params.model;
	}

	const hash = computeVibesHash(entry as unknown as Record<string, unknown>);
	return { entry, hash };
}

/**
 * Create a reasoning manifest entry pre-configured for external blob storage.
 * Used when reasoning text exceeds the external blob threshold (default 100 KB).
 * The entry has `external: true` and `blob_path` set; raw text and compressed text
 * are omitted. The caller is responsible for writing the blob data via `writeReasoningBlob()`.
 *
 * Returns the entry and its content-addressed hash.
 */
export function createExternalReasoningEntry(params: {
	blobPath: string;
	tokenCount?: number;
	model?: string;
}): { entry: VibesReasoningEntry; hash: string } {
	const entry: VibesReasoningEntry = {
		type: 'reasoning',
		external: true,
		blob_path: params.blobPath,
		created_at: new Date().toISOString(),
	};

	if (params.tokenCount !== undefined) {
		entry.reasoning_token_count = params.tokenCount;
	}
	if (params.model !== undefined) {
		entry.reasoning_model = params.model;
	}

	const hash = computeVibesHash(entry as unknown as Record<string, unknown>);
	return { entry, hash };
}

// ============================================================================
// Line Annotation
// ============================================================================

/**
 * Create a line-level annotation linking a code range to provenance metadata.
 * References manifest entries by their content-addressed hashes.
 */
export function createLineAnnotation(params: {
	filePath: string;
	lineStart: number;
	lineEnd: number;
	environmentHash: string;
	commandHash?: string;
	promptHash?: string;
	reasoningHash?: string;
	action: VibesAction;
	sessionId?: string;
	commitHash?: string;
	assuranceLevel: VibesAssuranceLevel;
}): VibesLineAnnotation {
	const annotation: VibesLineAnnotation = {
		type: 'line',
		file_path: params.filePath,
		line_start: params.lineStart,
		line_end: params.lineEnd,
		environment_hash: params.environmentHash,
		action: params.action,
		timestamp: new Date().toISOString(),
		assurance_level: params.assuranceLevel,
	};

	if (params.commandHash !== undefined) {
		annotation.command_hash = params.commandHash;
	}
	if (params.promptHash !== undefined) {
		annotation.prompt_hash = params.promptHash;
	}
	if (params.reasoningHash !== undefined) {
		annotation.reasoning_hash = params.reasoningHash;
	}
	if (params.sessionId !== undefined) {
		annotation.session_id = params.sessionId;
	}
	if (params.commitHash !== undefined) {
		annotation.commit_hash = params.commitHash;
	}

	return annotation;
}

// ============================================================================
// Function Annotation
// ============================================================================

/**
 * Create a function-level annotation linking a named function to provenance metadata.
 * References manifest entries by their content-addressed hashes.
 */
export function createFunctionAnnotation(params: {
	filePath: string;
	functionName: string;
	functionSignature?: string;
	environmentHash: string;
	commandHash?: string;
	promptHash?: string;
	reasoningHash?: string;
	action: VibesAction;
	sessionId?: string;
	commitHash?: string;
	assuranceLevel: VibesAssuranceLevel;
}): VibeFunctionAnnotation {
	const annotation: VibeFunctionAnnotation = {
		type: 'function',
		file_path: params.filePath,
		function_name: params.functionName,
		environment_hash: params.environmentHash,
		action: params.action,
		timestamp: new Date().toISOString(),
		assurance_level: params.assuranceLevel,
	};

	if (params.functionSignature !== undefined) {
		annotation.function_signature = params.functionSignature;
	}
	if (params.commandHash !== undefined) {
		annotation.command_hash = params.commandHash;
	}
	if (params.promptHash !== undefined) {
		annotation.prompt_hash = params.promptHash;
	}
	if (params.reasoningHash !== undefined) {
		annotation.reasoning_hash = params.reasoningHash;
	}
	if (params.sessionId !== undefined) {
		annotation.session_id = params.sessionId;
	}
	if (params.commitHash !== undefined) {
		annotation.commit_hash = params.commitHash;
	}

	return annotation;
}

// ============================================================================
// Session Record
// ============================================================================

/**
 * Create a session start/end record for tracking agent session boundaries.
 */
export function createSessionRecord(params: {
	event: 'start' | 'end';
	sessionId: string;
	environmentHash?: string;
	assuranceLevel?: VibesAssuranceLevel;
	description?: string;
}): VibesSessionRecord {
	const record: VibesSessionRecord = {
		type: 'session',
		event: params.event,
		session_id: params.sessionId,
		timestamp: new Date().toISOString(),
	};

	if (params.environmentHash !== undefined) {
		record.environment_hash = params.environmentHash;
	}
	if (params.assuranceLevel !== undefined) {
		record.assurance_level = params.assuranceLevel;
	}
	if (params.description !== undefined) {
		record.description = params.description;
	}

	return record;
}
