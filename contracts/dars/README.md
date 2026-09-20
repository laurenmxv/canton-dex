# Token Standard dependencies

The DEX contracts depend on the pinned `splice-token-standard-utils-2.0.0.dar`
listed in `manifest.yaml`. It includes the CIP-0112 allocation V2, allocation
instruction V2, holding V2 and metadata V1 API packages, so separate API DARs
are unnecessary. The `--package` build options in `daml.yaml` expose those
embedded packages to the compiler and must be retained.

`openzeppelin-tokenCIP112-v1-0.1.0.dar` is an unmodified build of OpenZeppelin's
[experimental token package](https://github.com/OpenZeppelin/canton-contracts/tree/535fa7cdab11a82c0476a6f9e9ecc7ebb90d3eaf/experiments/token/tokenCIP112-v1).
It supplies the local USDC, BTC and ETH test instruments. The separate faucet
package and contract tests consume it; the DEX contract package does not.
This is a draft experiment, not an OpenZeppelin release.

One issuer registry supports all three test instruments. Bootstrap funds
BTC/USDC and ETH/USDC pools and offers each trader one bundle of 10,000 USDC,
0.1 BTC and 2 ETH. These instruments have no connection to real assets.
The issuer controls minting; the operator has no issuer act-as or read-as rights.

`manifest.yaml` records each vendored DAR's exact source, package identity,
checksum and license. `splice-token-dependencies.yaml` records the upstream
provenance of the Splice packages contained in their dependency closures.
The token uses SDK 3.4.11 and LF 2.1, while application packages use their own
SDK/LF declarations. No issuer source patches are applied.

To reproduce the original token build from its pinned source:

```sh
gh api repos/OpenZeppelin/canton-contracts/tarball/535fa7cdab11a82c0476a6f9e9ecc7ebb90d3eaf > token-source.tar.gz
mkdir token-source
tar -xzf token-source.tar.gz -C token-source --strip-components=1
cd token-source
DAML_PACKAGE=experiments/token/tokenCIP112-v1 dpm build
DAML_PACKAGE=experiments/test/tokenCIP112-v1 dpm test --all --show-coverage
```
