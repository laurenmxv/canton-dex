# Canton Snap, development copy

These four files are the published `@chainsafe/canton-snap@1.0.0` package, from
<https://github.com/ChainSafe/canton-snap>, under the MIT licence, copyright
ChainSafe Systems. They are here so that `npm run dev:keycloak` can serve them
on `http://localhost:4040`, which is the Snap id this repository's development
environment installs.

## Why a copy exists

Stable MetaMask and MetaMask Flask both refuse to install the published package.
The build of MetaMask ships a copy of `fast-xml-parser` whose comment-closing
literal reads `-- >` rather than `-->`, so its icon validator rejects every SVG
that contains an XML comment with "Snap icon must be a valid SVG". The published
icon contains eleven comments.

## What differs from the published package

1. `images/icon.svg`: the XML comments are removed. Nothing else changed.
2. `snap.manifest.json`: `source.shasum` is recalculated over the new icon, as
   MetaMask requires the manifest checksum to match the files it fetches.

`dist/bundle.js` is byte-identical to the published one, so the signing code is
unchanged. Verify with:

```bash
shasum -a 256 dev/canton-snap/dist/bundle.js
```

## Checksums

| File | SHA-256 |
| --- | --- |
| `dist/bundle.js` | `2315b9d71a4204fcdd4da8c76c880764aaed950cb1b872a4e048feb8b807b7a8` |
| `snap.manifest.json` | `4bab05cf917e3dbddc0bb9aef3da7c21fecd4e37d1cefde81ffc69fe5345b345` |
| `package.json` | `c571c95f2c943ba72a4f70410c263d1087e74d028493ad5dea2b928ded0e18eb` |
| `images/icon.svg` | `ffd72cdd4b531e3048b706ff59ddc7701b1f2b5189543437b21e2fc081fbdff0` |

The manifest's own `source.shasum` is `hTR6sZaSSP474bqU9CKFGs5XtifrSrG2ls/mXN/OBPs=`.

## Scope

This copy is for development only. It is served from loopback, by the dev server
alone, and it never reaches a production build. A Snap derives its keys from its
id, so keys derived from `local:http://localhost:4040` are not the keys the
published Snap derives.
