# Per-process images

Build one image per Nest application from the monorepo root. `APP_NAME` must be
one of the applications in `nest-cli.json`:

```sh
docker build --build-arg APP_NAME=identity -t myota/identity:dev .
docker build --build-arg APP_NAME=activity-worker -t myota/activity-worker:dev .
```

The build compiles only the selected application. The runtime stage installs
production dependencies, copies that application's compiled output and the
shared event registry, then runs as the unprivileged `node` user. Configure
service-specific database URLs, NATS, storage, secrets, and ports at runtime.
Do not build a combined image that starts multiple database owners in one
process.

Publishing, immutable registry tags, image scanning, deployment manifests, and
rollout verification remain separate release gates.
