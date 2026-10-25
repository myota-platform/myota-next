# Per-process images

Build one image per Nest application from the monorepo root. `APP_NAME` must be
one of the applications in `nest-cli.json`:

```sh
docker build --build-arg APP_NAME=identity -t myota/identity:dev .
docker build --build-arg APP_NAME=activity-worker -t myota/activity-worker:dev .
docker build --target geodata-worker --build-arg APP_NAME=geodata-worker \
  -t myota/geodata-worker:dev .
```

The build compiles only the selected application. The runtime stage uses the
pinned nonroot Distroless Node 24 image and copies production dependencies, that
application's compiled output, the shared event registry, and a small launcher.
The Geodata worker target adds the `osmium` executable and its shared-library
dependencies for PBF imports. Configure service-specific database URLs, NATS,
storage, secrets, and ports at runtime. Do not build a combined image that
starts multiple database owners in one process.

The tools image uses the pinned Distroless Node 24 debug variant because the
migration job sequences its commands with `sh`. Other application images have
no shell.

Publishing, immutable registry tags, image scanning, deployment manifests, and
rollout verification remain separate release gates.

The browser applications have separate image contexts:

```sh
docker build -t myota/admin:dev web/admin
docker build -t myota/participant:dev web/participant
```

Admin is built with Vite and served by Nginx. Participant is a static site
served by the unprivileged Nginx image.
