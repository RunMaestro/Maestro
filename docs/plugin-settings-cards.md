# Plugin settings cards (Host API 1.23.0)

Existing `contributes.panels` with `placement: "settings"` become separate
Settings destinations. No plugin-specific names are hardcoded in the host.

```json
{
	"maestro": { "minHostApi": "1.23.0" },
	"permissions": [{ "capability": "ui:panel" }],
	"contributes": {
		"panels": [
			{
				"id": "config",
				"title": "Plugin preferences",
				"entry": "panel.html",
				"placement": "settings",
				"hostSettings": ["media"]
			}
		]
	}
}
```

The canonical panel identity stays `<pluginId>/<localId>`. Its Settings
navigation/search destination is `plugin-settings:<pluginId>/<localId>`, derived
from that identity, never from title, installation path or plugin version.
Settings search indexes the title, plugin ID and local panel ID. The sidebar and
keyboard tab navigation list the same destinations. Plugin management retains a
launch button. Host callers deep-link with Settings `settingId` set to that
value; `maestro.ui.openPanel('config')` opens the caller's own settings card.
`closePanel`/`togglePanel` remain modal-only; they cannot dismiss host Settings.

Cards, search entries, and panel documents require an enabled, loadable,
trusted plugin with live `ui:panel` consent. Disable, uninstall, identity change,
revoke, feature-off or failed contribution refresh remove the executable
surface. The plugin-management entry remains available for explaining status
and requesting consent. Existing guest isolation/provenance and command bridges
are reused; settings panels no longer mount in Display or as duplicate overlays.

`hostSettings` is an optional closed list, currently only `["media"]`, accepted
only on settings panels. It draws a host-owned button to the existing
`environment-host-media` section. The plugin never receives model-directory
paths or host setting values. Only the host renderer's validated persistence
channel can change `mediaModelDirectory`; plugin `settings.set` remains confined
to `plugins.<ownId>.*`, and `settings.get('mediaModelDirectory')` is denied.
Navigation does not grant permissions or enable plugins. No host or plugin
restart is necessary to update host media configuration.

Maestro-Backstage can keep `sh.maestro.relay/config`, add `hostSettings: ["media"]`,
and use the existing own-panel open command. This contract was discussed with
its agent `78582d73-395d-4839-a62d-e903f0f1cecc`; it does not install or modify Relay.
