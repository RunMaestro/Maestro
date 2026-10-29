export interface CodexMemorySourceRef {
	sourceAgentId: string;
	provider: 'codex';
	location: { kind: 'local' };
	codexHome: string;
	memoryRoot: string;
	relativePath: string;
}
