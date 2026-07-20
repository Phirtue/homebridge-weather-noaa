# Verifying Releases

Every release of this plugin ships three independent attestations. This
page gives the exact commands to check each one, so the attestations
are a usable trust chain rather than badges. All three verifications
are offline-verifiable signatures rooted in the public Sigstore
transparency log; none require trusting this repository's maintainer.

What each attestation proves:

| Attestation | Proves | Tool |
| ----------- | ------ | ---- |
| npm provenance | The package on npmjs.com was built and published by this repository's GitHub Actions workflow from a specific commit | `npm` |
| SLSA build provenance | The release tarball and SBOM were produced by the pinned workflow at a specific commit, attested by an isolated builder the publish job cannot influence | `slsa-verifier` |
| Sigstore SBOM signature | The SBOM attached to the GitHub release is the one the release workflow generated | `cosign` |

## 1. npm provenance

Requires npm 9.5+ and the package installed in a project:

```bash
npm install homebridge-weather-noaa
npm audit signatures
```

Expected output includes:

```
audited 1 package in ...
1 package has a verified registry signature
1 package has a verified attestation
```

The attestation links the tarball to this repository, the publish
workflow, and the exact source commit. You can also inspect it on the
package's [npmjs.com page](https://www.npmjs.com/package/homebridge-weather-noaa)
under "Provenance".

## 2. SLSA build provenance (v1.9.1 and later)

Install [slsa-verifier](https://github.com/slsa-framework/slsa-verifier),
then download the tarball and provenance from the
[GitHub release](https://github.com/Phirtue/homebridge-weather-noaa/releases)
you want to verify (substitute the version):

```bash
VERSION=1.9.2
BASE=https://github.com/Phirtue/homebridge-weather-noaa/releases/download/v${VERSION}
curl -sSLO "${BASE}/homebridge-weather-noaa-${VERSION}.tgz"
curl -sSLO "${BASE}/homebridge-weather-noaa.intoto.jsonl"

slsa-verifier verify-artifact "homebridge-weather-noaa-${VERSION}.tgz" \
  --provenance-path homebridge-weather-noaa.intoto.jsonl \
  --source-uri github.com/Phirtue/homebridge-weather-noaa \
  --source-tag "v${VERSION}"
```

Expected output ends with:

```
PASSED: SLSA verification passed
```

The same command with `sbom.cdx.json` as the artifact verifies the SBOM,
which is covered by the same provenance file.

`npm pack` normalizes tarball timestamps, so the release tarball is
byte-identical to what `npm publish` sent to the registry: verifying
the release asset also verifies the npm artifact's bytes.

## 3. Sigstore SBOM signature (all releases since v1.7.0)

Install [cosign](https://docs.sigstore.dev/cosign/system_config/installation/),
then download the SBOM and its signature bundle from the release:

```bash
VERSION=1.9.2
BASE=https://github.com/Phirtue/homebridge-weather-noaa/releases/download/v${VERSION}
curl -sSLO "${BASE}/sbom.cdx.json"
curl -sSLO "${BASE}/sbom.cdx.json.sigstore.json"

cosign verify-blob sbom.cdx.json \
  --bundle sbom.cdx.json.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/Phirtue/homebridge-weather-noaa/.github/workflows/publish.yml@refs/tags/v${VERSION}"
```

Expected output:

```
Verified OK
```

The certificate identity pins the signature to this repository's
publish workflow running for that exact tag — a signature produced by
any other workflow, repository, or ref fails verification.

One historical note: the SBOMs on releases v1.7.0 through v1.9.0 were
signed retroactively by a dedicated backfill workflow rather than at
publish time, so for those releases use this identity instead:

```bash
  --certificate-identity "https://github.com/Phirtue/homebridge-weather-noaa/.github/workflows/sign-release-sboms.yml@refs/heads/main"
```

(Signatures are present-tense claims about bytes, so backfilling them
was truthful; build provenance was deliberately NOT backfilled, because
it claims how an artifact was built and cannot be honestly generated
after the fact. That is why SLSA provenance starts at v1.9.1.)

## What a failure means

Any of these commands failing means the artifact you downloaded is not
the one the workflow produced — a modified tarball, a re-uploaded
asset, or a signature from the wrong identity. Do not install it, and
please report it privately via the
[security policy](./SECURITY.md).
