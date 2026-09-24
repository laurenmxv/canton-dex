# LocalNet artifact

`cn-localnet-v0.3.0.tar.gz` is the CN Quickstart LocalNet release vendored in this
repository. `make prepare-localnet` verifies its SHA-256 against the Makefile pin and
extracts it into `.deps/cn-localnet`. The extraction marker records that checksum, so
an archive update always replaces the extracted files.

- Version: `v0.3.0`
- Release: [LocalNet v0.3.0](https://github.com/raynaudoe/cn-quickstart/releases/tag/localnet-v0.3.0)
- SHA-256: `5fcc0f5f55aaa298fa29d6571abe5038a1ad0c84d771c5d0274621d5e91897cf`
- Source commit: `032f05855d6e6a36c931459abbd81baa63c4e2c1` on `TS-backend-template`
  in [raynaudoe/cn-quickstart](https://github.com/raynaudoe/cn-quickstart).
  `manifest.json` records the commit and every file checksum.
- This replaces the unpublished `v0.2.0` snapshot with a published release. The
  infrastructure payload is unchanged; the source repository provides the empty
  TypeScript backend template. The DEX keeps its own TypeScript backend.
- The application participant serves the JSON Ledger API v2 on
  port 7575 of the Compose network, with the ledger API's JWT authorization. No host
  port is published.
- The archive includes its file manifest, license and terms.

The bundle contains configuration and scripts. Docker Compose downloads the images
separately.

To update LocalNet, add the new archive, replace this file's version, checksum and
provenance, and update `LOCALNET_VERSION` and `LOCALNET_SHA256` in the Makefile.
