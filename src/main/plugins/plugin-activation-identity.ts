export interface PluginActivationIdentity {
	ownerPluginId: string;
	generation: number;
	artifactDigest: string;
	authorizationContentHash: string;
	signerKeyId: string;
}
