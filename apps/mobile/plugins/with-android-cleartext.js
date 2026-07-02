// Expo config plugin: set android:usesCleartextTraffic="true" on the
// <application> element so release builds can reach the desktop over
// http://<lan-ip>:<port> and ws://<lan-ip>:<port>. Without this, Android 9+
// release builds reject the pairing redemption and the WebSocket handshake.
const { withAndroidManifest } = require('@expo/config-plugins');

const withAndroidCleartext = (config) =>
	withAndroidManifest(config, (cfg) => {
		const application = cfg.modResults.manifest.application?.[0];
		if (!application) return cfg;
		application.$ = {
			...application.$,
			'android:usesCleartextTraffic': 'true',
		};
		return cfg;
	});

module.exports = withAndroidCleartext;
