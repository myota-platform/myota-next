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
trivy config --severity HIGH,CRITICAL deploy/helm
zizmor .github/workflows
```

The pull-request workflows now run dependency audits and Trivy filesystem
scanning. The image workflow builds each application image without publishing
it and scans the result. Image scans currently fail on fixable HIGH and
CRITICAL findings; upstream findings without a usable image fix are listed
below. Workflow security is checked with zizmor. The infrastructure chart is
linted with object storage enabled.

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
  npx after installation. The Node image CI scan uses `ignore-unfixed` for
  upstream OS packages that have no available patched image build.
- NATS was updated to
  `nats:2.14.8-alpine3.22@sha256:fce5fbf8b29ee0baa790e67bcd4abafebdd97363aa025f7d46a17489df002e30`.
  A direct Trivy scan found one HIGH Go standard-library finding (CVE-2026-111943,
  fixed upstream in Go 1.26.10 or 1.27.3); the previous pinned image had 19
  HIGH findings.
- The AWS CLI image used only for bucket initialization had 15 HIGH findings.
  The Helm hook and Compose service now use the MyOTA tools image and an
  idempotent S3 SDK helper, removing that image from the runtime inputs.
- The pinned PostgreSQL image has one CRITICAL and 25 HIGH findings in the
  bundled `gosu` binary, built with Go 1.24.6. The pinned PostGIS image has the
  same Go findings plus one HIGH Alpine `brotli-libs` finding. Trivy reports
  upstream fixed Go versions, but the pinned upstream PostgreSQL/PostGIS image
  digests still contain the old binary. These findings require an upstream
  rebuild or a reviewed MyOTA-derived database image. They remain open and are
  not hidden by the CI `ignore-unfixed` setting.
- Trivy configuration findings are hardening recommendations, not package CVEs.
  The app chart scan reported 42 HIGH findings: 14 missing
  `readOnlyRootFilesystem` settings (KSV-0014) and 28 default security-context
  findings (KSV-0118). The infrastructure chart scan with object storage
  enabled reported 13 HIGH findings: four KSV-0014, eight KSV-0118, and one
  KSV-0109 false positive caused by a password environment-variable name in
  the database init command. No secret value was found in the ConfigMap.
  Track these configuration changes separately from the dependency/image
  vulnerability gate.
- GitHub reported no open Dependabot alerts at review time. Code scanning had
  no completed analysis, and repository secret scanning was disabled. Neither
  status is treated as evidence of a clean scan. Dependabot now covers the
  root and admin npm manifests, Docker inputs, and GitHub Actions.

## Follow-up

Issue [#28](https://github.com/myota-platform/myota-next/issues/28) remains
open for the PostgreSQL and PostGIS base-image findings and the Helm hardening
review. The owning team is `myota-platform` maintainers; recheck upstream
images by 2026-11-25. Do not promote an image with the database findings to
production without a patched upstream digest or an explicit, time-limited
security acceptance recorded in that issue.

## References

- [OpenTelemetry JavaScript 3.x migration guide](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/3.x/migration-guide.md)
- [zizmor workflow security audits](https://docs.zizmor.sh/audits/)
- [Trivy filesystem scanner](https://trivy.dev/latest/docs/target/filesystem/)
- [Trivy image scanner](https://trivy.dev/latest/docs/target/container_image/)
