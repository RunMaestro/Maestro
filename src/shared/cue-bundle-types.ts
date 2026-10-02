/**
 * Cue bundle - the versioned, portable archive format for a Cue pipeline or a
 * single agent.
 *
 * A bundle is a zip whose root holds `manifest.json` (this module's
 * {@link CueBundleManifest}) and a generated `README.md`. Everything else is
 * addressed by a WORKSPACE KEY rather than by an absolute path, so a bundle
 * carries no trace of the machine it was exported on and can be imported into
 * a project checked out anywhere:
 *
 * ```
 * manifest.json
 * README.md
 * layout/pipeline.json                     (pipeline bundles only)
 * agents/<agentId>.json                    agent settings
 * agents/<agentId>/playbooks.json          saved playbooks
 * workspaces/<key>/.maestro/cue.yaml       filtered subscriptions + settings
 * workspaces/<key>/<project-relative path> prompt files, Auto Run documents
 * autorun/<agentId>/<filename>.md          Auto Run documents outside the workspace
 * ```
 *
 * Keep this module runtime-agnostic: it is read by the exporter (main and
 * CLI), and later by an importer and any renderer surface that previews one.
 */

/** Bump only on a breaking change to the archive layout or this manifest. */
export const CUE_BUNDLE_VERSION = 1;

/**
 * Oldest Cue engine that can run what a bundle describes. An importer refuses a
 * bundle whose `minEngineVersion` is newer than itself instead of writing a
 * `cue.yaml` the local engine would half-understand.
 */
export const CUE_BUNDLE_MIN_ENGINE_VERSION = '0.18.0';

/** Archive file name of the manifest at the zip root. */
export const CUE_BUNDLE_MANIFEST_PATH = 'manifest.json';

/** Archive file name of the generated human summary at the zip root. */
export const CUE_BUNDLE_README_PATH = 'README.md';

/** Archive path of the pipeline's layout entry (pipeline bundles only). */
export const CUE_BUNDLE_LAYOUT_PATH = 'layout/pipeline.json';

/** What a bundle captures: one visual pipeline, or one agent. */
export type CueBundleKind = 'maestro-pipeline' | 'maestro-agent';

/** One file stored in the archive, verifiable against its bytes. */
export interface CueBundleFileEntry {
	/** Archive path, forward-slash separated, never absolute, never `..`. */
	path: string;
	/** Lowercase hex SHA-256 of the stored bytes. */
	sha256: string;
	/** Size of the stored bytes. */
	size: number;
}

/** Where a workspace's code came from, so an importer can tell the user what to clone. */
export interface CueBundleWorkspaceSource {
	/** `origin` remote with any userinfo or token stripped. */
	gitRemote?: string;
	/** Branch checked out at export time, when HEAD named one. */
	gitBranch?: string;
	/** Full commit SHA HEAD resolved to at export time (branch tip or detached HEAD). */
	gitRef?: string;
}

/**
 * One project root. Every agent and every file that lived under that root is
 * filed under its key, which is the ONLY name a bundle has for it.
 */
export interface CueBundleWorkspace {
	/** Deterministic slug of the project root's folder name (`-2`, `-3` on collision). */
	key: string;
	/** The project root's folder name, for display. */
	name: string;
	/** Archive path of this workspace's filtered cue.yaml, when it contributed one. */
	cueConfig?: string;
	source?: CueBundleWorkspaceSource;
}

/** One agent the bundle carries settings for. */
export interface CueBundleAgent {
	/** The agent's id on the exporting machine. Subscriptions reference it. */
	id: string;
	name: string;
	toolType: string;
	/** Key of the workspace the agent's project root maps to. */
	workspace: string;
	/** Archive path of the agent's settings file ({@link CueBundleAgentSettings}). */
	settings: string;
	/** Archive path of the agent's saved playbooks, when it has any. */
	playbooks?: string;
}

/** Location of an agent's Auto Run folder, without its absolute path. */
export type CueBundleAutoRunLocation =
	| {
			/** The folder sits inside a workspace. */
			workspace: string;
			/** Folder path relative to the workspace root ('' for the root itself). */
			path: string;
	  }
	| {
			/** The folder sat outside every workspace; its documents were copied here. */
			bundlePath: string;
	  };

/** Contents of `agents/<agentId>.json`. */
export interface CueBundleAgentSettings {
	id: string;
	name: string;
	toolType: string;
	workspace: string;
	/** Working directory relative to the workspace root ('' when it IS the root). */
	cwd?: string;
	autoRun?: CueBundleAutoRunLocation;
	customModel?: string;
	customEffort?: string;
	customArgs?: string;
	customContextWindow?: number;
	newSessionMessage?: string;
	nudgeMessage?: string;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	env?: {
		/** Non-secret variables, exported with their values. */
		values?: Record<string, string>;
		/** Secret variables. Only the NAME travels; the importer must supply a value. */
		required?: string[];
		/** Variables whose value was a path on the exporting machine. Name only. */
		machineSpecific?: string[];
	};
}

/** What the importing machine must provide before the bundle can run. */
export interface CueBundleRequirements {
	/** Distinct Cue event types the subscriptions listen on. */
	events: string[];
	/** Command-line tools the subscriptions or workspaces depend on (`gh`, `git`). */
	tools: string[];
	/** Environment variable names that must hold a secret on the importing machine. */
	secrets: string[];
}

/** Contents of `manifest.json`. */
export interface CueBundleManifest {
	bundleVersion: typeof CUE_BUNDLE_VERSION;
	kind: CueBundleKind;
	producer: { app: 'maestro'; version: string };
	minEngineVersion: string;
	/** Pipeline name (pipeline bundles) or agent name (agent bundles). */
	name: string;
	workspaces: CueBundleWorkspace[];
	agents: CueBundleAgent[];
	requirements: CueBundleRequirements;
	/** Every archive entry except the manifest itself, sorted by path. */
	files: CueBundleFileEntry[];
	/** Things the importer should tell the user (SSH agents, dangling references). */
	warnings?: string[];
	/**
	 * ISO-8601 export time. Omitted unless the caller pins one (`--created-at`
	 * or `SOURCE_DATE_EPOCH`), so two exports of the same data are identical.
	 */
	createdAt?: string;
}
