# LocalNet artifact

`cn-localnet-v0.2.0.tar.gz` is the CN Quickstart LocalNet release vendored in this
repository. `make prepare-localnet` verifies its SHA-256 against the Makefile pin and
extracts it into `.deps/cn-localnet`. The extraction marker records that checksum, so
an archive update always replaces the extracted files.

- Version: `v0.2.0`
- SHA-256: `1f69385e1fe50eece22e01ee226abd3433b34d329acd4401cd1a32d63c056309`
- Source commit: `74f28707e6d515c6ad0cc7cea45cf1d0b92cf0bf`, a local release snapshot
  that is not published. Its parent is `cee8ccdd3d70f9bd3b37fdc55953fc801ff5f033` of
  [raynaudoe/cn-quickstart](https://github.com/raynaudoe/cn-quickstart), which produced
  `v0.1.0`. `manifest.json` in the archive records the commit and every file checksum.
- Change from `v0.1.0`: the application participant serves the JSON Ledger API v2 on
  port 7575 of the Compose network, with the ledger API's JWT authorization. No host
  port is published.
- The archive includes its file manifest, license and terms.

The bundle contains configuration and scripts. Docker Compose downloads the images
separately.

To update LocalNet, add the new archive, replace this file's version, checksum and
provenance, and update `LOCALNET_VERSION` and `LOCALNET_SHA256` in the Makefile.
