export interface KnownAuthDirs {
	claudeConfigDirs: string[];
	codexHomes: string[];
	/** `GROK_HOME` values configured on Grok agents or Grok's provider settings. */
	grokHomes: string[];
}

export const EMPTY_KNOWN_AUTH_DIRS: KnownAuthDirs = {
	claudeConfigDirs: [],
	codexHomes: [],
	grokHomes: [],
};
