# MyOTA Participant

This is the baseline static participant client, kept as a separate deployable
artifact from the Admin application. It presents programme content, entity
catalogue/map views, map-picked new point and existing-candidate proposals, profile editing
and images, award requests, and activation/QSO workflows through the Gateway. Domain data,
callsign authorization, and eligibility decisions remain owned by the APIs.

The source is under `web/`. Build its image from this directory with:

```sh
docker build -t myota/participant:dev .
```

Deployment integration and route-by-route behavioral parity remain open. The
current activation flow can start an activation, record a single QSO, and close
an open activation; it still needs browser-level compatibility coverage.
