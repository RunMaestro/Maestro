export interface PluginActivationIdentity {
	ownerPluginId: string;
	generation: number;
	artifactDigest: string;
	signerKeyId: string;
}
