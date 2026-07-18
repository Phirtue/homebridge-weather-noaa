# Contributing

Thanks for your interest in improving this plugin. Contributions of all
kinds are welcome: bug reports, feature requests, documentation fixes,
and code.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/Phirtue/homebridge-weather-noaa/issues).
For bugs, include your Homebridge and Node.js versions, the plugin
version, relevant log output (debug level if possible), and steps to
reproduce.

**Security issues are the exception:** never open a public issue for a
vulnerability. Follow the private reporting process in
[SECURITY.md](SECURITY.md) instead.

## Contributing code

Changes are accepted through GitHub pull requests against the `main`
branch:

1. Fork the repository and create a topic branch.
2. Make your changes. Keep pull requests focused on a single concern.
3. Run the full local gate before pushing:

   ```bash
   npm ci
   npm run lint    # ESLint, zero warnings allowed
   npm run build   # TypeScript, strict mode
   npm test        # Vitest unit and property-based tests
   ```

4. Open a pull request describing what changed and why.

Every pull request runs the CI matrix (multiple Node.js and Homebridge
versions), CodeQL static analysis, and dependency review. All checks
must pass before a change can merge; `main` is protected and cannot be
pushed to directly.

### Requirements for acceptable contributions

- **Tests accompany functionality.** As a general policy, when major
  new functionality is added, tests exercising it are added to the
  suite in the same pull request. Bug fixes should include a test that
  fails without the fix. Explain in the pull request how the change is
  covered.
- **No new runtime dependencies.** The published package deliberately
  ships with zero runtime dependencies; CI enforces this. Development
  dependencies must be pinned or version-constrained in line with the
  existing lockfile policy.
- **Match the existing style.** ESLint and the TypeScript strict
  options define the baseline; `npm run lint` must pass with zero
  warnings. Comments explain intent and trade-offs, not what the code
  already says.
- **Keep the security posture.** Anything touching the HTTP client,
  cache files, or configuration parsing should preserve the existing
  validation and clamping invariants (see the property-based tests in
  `test/property.test.ts` for the invariants that must keep holding).

## Legal

By contributing, you agree that your contributions are licensed under
the [MIT License](LICENSE) that covers this project.
