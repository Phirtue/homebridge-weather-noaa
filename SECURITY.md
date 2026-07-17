# Security Policy

Security reports are welcome and appreciated. This project aims to be a
best-practice example of a secure Homebridge plugin, and that only works
if people who find problems have a safe, private way to tell us.

## Supported Versions

Only the [latest released version](https://github.com/Phirtue/homebridge-weather-noaa/releases/latest)
receives security fixes. If you are on an older version, upgrade before
reporting — the issue may already be fixed.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/Phirtue/homebridge-weather-noaa/security)
2. Click **Report a vulnerability**
   (direct link: [new advisory](https://github.com/Phirtue/homebridge-weather-noaa/security/advisories/new))
3. Describe the issue, affected version(s), and reproduction steps

Only you and the maintainer can see the report. GitHub provides a private
workspace to discuss the issue and develop a fix before anything becomes
public.

### What to expect

| Stage | Commitment |
| ----- | ---------- |
| Acknowledgment | within 48 hours |
| Triage verdict (accepted / declined / need info) | within 7 days |
| Fix and coordinated disclosure | within 90 days, usually much sooner |

When a fix ships, a GitHub Security Advisory is published (with a CVE
where warranted) so `npm audit` and Dependabot notify affected users
automatically. Reporters are credited in the advisory and release notes
unless they prefer to remain anonymous.

## Scope

**In scope**

- The plugin source code (`src/`) — input validation, cache file
  handling, HTTP client behavior, HomeKit characteristic handling
- The published npm package and its contents
- The release pipeline (GitHub Actions workflows in this repository)

**Out of scope**

- Homebridge, HAP-NodeJS, or HomeKit themselves — report to the
  [Homebridge project](https://github.com/homebridge/homebridge/security)
- The NOAA / NWS API — report to [NWS](https://www.weather.gov/contact)
- Vulnerabilities in development-only dependencies that do not affect the
  published package (this plugin ships **zero runtime dependencies**)
- Issues requiring an already-compromised Homebridge host beyond the
  plugin's threat model (note: tampered plugin cache files *are* in
  scope — the plugin is expected to handle them safely)

## Safe Harbor

Good-faith security research within the scope above is welcome. We will
not pursue legal action for research that makes a reasonable effort to
avoid privacy violations, data destruction, and service disruption, and
that gives us a chance to remediate before public disclosure.

## Verifying Releases

Every release is independently verifiable:

- **npm provenance** — packages are published from GitHub Actions via
  [trusted publishing](https://docs.npmjs.com/trusted-publishers) with a
  Sigstore attestation linking the tarball to the exact source commit
  and workflow run. Verify with:

  ```bash
  npm audit signatures
  ```

- **SBOM** — a CycloneDX software bill of materials is attached to every
  [GitHub release](https://github.com/Phirtue/homebridge-weather-noaa/releases).
- **No install scripts, no runtime dependencies** — the published package
  contains only compiled plugin code; CI fails if a runtime dependency
  is ever introduced.

## Security Measures in This Project

For reviewers and the curious: this repository runs CodeQL static
analysis, dependency review on every PR, lockfile linting (registry-only
https sources), script-less CI installs, SHA-pinned GitHub Actions with
least-privilege tokens, Dependabot updates, and branch protection
requiring all checks to pass before anything reaches `main`.
