# GameSpace RPC icons

Icon manifest for GameSpace's Discord Rich Presence.

GameSpace fetches:

```text
https://cdn.jsdelivr.net/gh/Edith-AOSP/gamespace-rpc-icons@main/index.json
```

and uses the `icon` URL as the Rich Presence `large_image`. Discord fetches the
image directly; nothing is uploaded to the Discord Developer Portal.

## Manifest

```json
{
  "schema": 1,
  "updated": "2026-10-29T00:00:00Z",
  "games": {
    "com.miHoYo.GenshinImpact": {
      "name": "Genshin Impact",
      "icon": "https://cdn.jsdelivr.net/gh/Edith-AOSP/gamespace-rpc-icons@main/icons/com.miHoYo.GenshinImpact-0123abcd.png",
      "source": "https://play.google.com/store/apps/details?id=com.miHoYo.GenshinImpact&hl=en&gl=US",
      "updated": "2026-10-29T00:00:00Z"
    }
  }
}
```

## Updating

The GitHub Action runs weekly and on manual dispatch:

1. Reads `games.json`.
2. Resolves the Play Store icon for each package.
3. Mirrors it into `icons/` with a content hash in the filename.
4. Writes `index.json`.
5. Commits only when something changed.

Add games by appending their package name to `games.json`. Use
`overrides.json` for region-locked or missing listings:

```json
{
  "com.example.game": {
    "name": "Example Game",
    "icon": "https://example.com/icon.png"
  }
}
```

The workflow keeps the previous entry when a lookup fails, so a transient
Play Store failure never removes an icon.

## Licensing

Game icons are the property of their respective publishers. This repository
mirrors them only to make Rich Presence work and will remove entries on
request. The code is Apache-2.0.
