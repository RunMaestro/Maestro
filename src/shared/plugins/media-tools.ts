/** Bounded media primitives. STT orchestration and result interpretation belong to plugins. */
export const MEDIA_LIMITS = {
	maxDownloadBytes: 8 * 1024 * 1024,
	maxDurationSeconds: 120,
	jobTimeoutMs: 120_000,
	maxProcessOutputBytes: 16 * 1024,
	maxResultBytes: 128 * 1024,
	maxPcmBytes: 4 * 1024 * 1024,
	maxJobsPerPlugin: 2,
	maxJobs: 4,
} as const;

/** Only multilingual model IDs; never a plugin-selected filesystem path. */
export const MEDIA_MODEL_IDS = [
	'tiny',
	'base',
	'small',
	'medium',
	'large-v1',
	'large-v2',
	'large-v3',
	'large-v3-turbo',
] as const;
export type MediaModelId = (typeof MEDIA_MODEL_IDS)[number];
export const MEDIA_ERROR_CODES = [
	'MediaInvalid',
	'MediaDenied',
	'MediaUnavailable',
	'MediaTooLarge',
	'MediaTooLong',
	'MediaTimeout',
	'MediaCancelled',
	'MediaBusy',
	'MediaProcessFailed',
	'MediaOutputTooLarge',
] as const;
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

/** Stable error.code across the host RPC; diagnostic text contains only this code. */
export interface MediaFailure extends Error {
	code: MediaErrorCode;
}

export interface MediaProbe {
	container: 'ogg' | 'wav';
	durationSeconds: number;
	streams: { type: 'audio'; codec: 'opus' | 'pcm_s16le'; sampleRate: number; channels: number }[];
}
export interface MediaToolStatus {
	profiles: 'whisper-cli'[];
	models: MediaModelId[];
	missing: ('ffprobe' | 'ffmpeg' | 'whisper-cli' | 'model-directory')[];
}
export interface MediaRunOptions {
	profile: 'whisper-cli';
	model: MediaModelId;
	/** Lowercase Whisper language code or auto (default). Translation is always off. */
	language?: string;
}
export interface MaestroMediaApi {
	status(): Promise<MediaToolStatus>;
	/** Reserves an opaque job without I/O. Fixed deadline starts here. */
	open(): Promise<{ jobId: string }>;
	download(jobId: string, url: string): Promise<{ audioId: string; bytes: number }>;
	probe(jobId: string, audioId: string): Promise<MediaProbe>;
	decode(jobId: string, audioId: string): Promise<{ audioId: string; durationSeconds: number }>;
	run(jobId: string, audioId: string, options: MediaRunOptions): Promise<{ json: string }>;
	/** Cancels pending work, waits for child exit and removes all artifacts. Idempotent. */
	close(jobId: string): Promise<void>;
}
