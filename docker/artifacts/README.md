# LocalNet artifact

`cn-localnet-v0.1.0.tar.gz` is the unchanged CN Quickstart LocalNet release,
checked into this repository. `make prepare-localnet` extracts it into
`.deps/cn-localnet`; subsequent runs reuse the extracted files.

- Source: [CN Quickstart localnet-v0.1.0](https://github.com/raynaudoe/cn-quickstart/releases/tag/localnet-v0.1.0)
- SHA-256: `68589de6ee411ea50d5621ad716baff3de64a5e0c1609b1d5c845acbef25753c`
- The archive includes its file manifest, license and terms.

The bundle contains configuration and scripts. Docker images are downloaded
separately by Docker Compose.

To update LocalNet, replace the archive with a verified release, update the
Makefile archive path and this checksum, and remove `.deps/cn-localnet` before
preparing the new version.
