# Dependency and workflow security review

Reviewed on 2026-10-25 against the `testing` baseline and the changes in this
branch. Re-run these checks before merging and whenever the affected lockfiles,
images, workflows, or Helm charts change.

## Scope and commands

The review covered both npm lockfiles, the checked-in source for secret-like
values, application and infrastructure container images, Helm templates, and
GitHub Actions workflows.

```sh
npm ci
npm run audit:dependencies
npm ci --prefix web/admin
npm audit --audit-level=low --prefix web/admin
trivy fs --scanners vuln,secret --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 .
trivy config --config .github/trivy.yaml --severity HIGH,CRITICAL --exit-code 1 deploy/helm
zizmor .github/workflows
```

The pull-request workflows run dependency audits, source and secret scanning,
rendered Helm misconfiguration scanning, and image build/scans without
publishing. The same build-and-scan gate must pass for a GitHub release before
release images are published. Helm scans render both charts with representative
values, including enabled object storage.

## Results

- Node.js 24.22.0 with npm 11.19.1: clean root and admin installs; both npm
  audits reported zero vulnerabilities. `npm ls shapefile text-encoding`
  confirms the deprecated decoder package is absent. `@nestjs/mau` was unused
  and has been removed. The admin Vite dependency is updated to a patched
  release. NestJS 12 and `@nestjs/observe` remain in the root dependencies.
- Trivy 0.76.1 filesystem scan: zero HIGH or CRITICAL findings in either npm
  lockfile and zero detected secrets in scanned tracked source. Trivy omits
  development dependencies by default; npm audit covers both production and
  development dependencies.
- zizmor 1.31.1: no workflow findings after pinning third-party actions to
  verified full commit SHAs, disabling checkout credential persistence,
  disabling setup-node package-manager caching in the release-quality job,
  and documenting elevated token permissions.
- The pinned SeaweedFS and unprivileged Nginx images had no HIGH or CRITICAL
  findings in the initial image review. The Node runtime images remove npm and
  npx after installation. Final image scans include fixed and unfixed HIGH or
  CRITICAL findings; any remaining result blocks release publication.
- The pinned PostgreSQL 16 image contains `gosu` 1.19, built with Go 1.24.6.
  Current Trivy data reports 26 HIGH/CRITICAL Go standard-library findings;
  binary-level `govulncheck` additionally finds GO-2026-6686 in the bundled
  `moby/sys/user` 0.1.0 parser. The release-built MyOTA PostgreSQL images now
  replace `gosu` with a build from upstream commit
  `29b939aa5bd4dc588af765b8248f6e39150d2565` (gosu 1.20), using the pinned Go
  1.26.10 builder. The rebuilt binary uses `moby/sys/user` 0.4.1, and
  `govulncheck -mode=binary` reports no vulnerabilities for it.
- The pinned PostGIS 16 image has the same old `gosu` plus HIGH CVE-2026-111497
  in `brotli-libs` 1.2.0-r1. The MyOTA PostGIS image updates that package to
  Alpine's fixed 1.2.1-r0 and replaces `gosu` as above.
- NATS 2.14.8 had 19 HIGH findings; 2.15.1 reduced this to one HIGH,
  CVE-2026-111943 (GO-2026-6809), reachable through
  `crypto/x509.Certificate.Verify` in the current NATS binary. The release-built
  MyOTA NATS image rebuilds upstream NATS 2.15.1 commit
  `b2fd3efc7456b11b06a54877ad6f6ccfb911edb4` with Go 1.26.10, which contains
  the upstream fix. Runtime smoke verification of that binary returned NATS
  health status `ok`. `govulncheck` also reports the unmaintained OpenPGP
  package advisory from the `golang.org/x/crypto` module; NATS does not import
  `golang.org/x/crypto/openpgp` (`go mod why` reports that the root module does
  not need that package), and the final Trivy image scan remains the release
  gate.
- The AWS CLI image used only for bucket initialization had 15 HIGH findings.
  The Helm hook and Compose service now use the MyOTA tools image and an
  idempotent S3 SDK helper, removing that image from the runtime inputs.
- Trivy Helm configuration findings are addressed. Application containers now
  use explicit non-root, read-only-root-filesystem, dropped-capability,
  no-privilege-escalation, and RuntimeDefault seccomp settings, with writable
  temporary and Nginx paths mounted as `emptyDir`. Database and object-storage
  workloads use explicit non-root identities and read-only root filesystems.
  The database role-init script is baked into the release-built database image
  instead of rendered as a ConfigMap; this removes the KSV-0109 false positive
  on the SQL keyword `PASSWORD` (the ConfigMap contained no secret value).
  `trivy config --config .github/trivy.yaml` reports zero HIGH or CRITICAL
  findings across both rendered charts.
- The infrastructure chart requires release-built database image references;
  its values example points at same-release MyOTA images. Compose and CI use
  the pinned-source MyOTA images. NATS remains external for Helm deployments;
  its operator must use the matching release-built image.
- GitHub reported no open Dependabot alerts at review time. Code scanning had
  no completed analysis, and repository secret scanning was disabled. Neither
  status is treated as evidence of a clean scan. Dependabot now covers the
  root and admin npm manifests, Docker inputs, and GitHub Actions.

## Follow-up

The upstream images remain unchanged and still report findings, but deployable
references are replaced by MyOTA-derived images built from pinned source and
patched inputs. Pull-request and release workflows build and scan the final
images before release publication. The PR image scan is still required to
complete this review; release outputs include immutable digests and provenance.

## References

- [OpenTelemetry JavaScript 3.x migration guide](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/3.x/migration-guide.md)
- [zizmor workflow security audits](https://docs.zizmor.sh/audits/)
- [Trivy filesystem scanner](https://trivy.dev/latest/docs/target/filesystem/)
- [Trivy image scanner](https://trivy.dev/latest/docs/target/container_image/)
