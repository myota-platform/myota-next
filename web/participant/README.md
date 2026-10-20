# MyOTA Participant

This is the baseline static participant client, kept as a separate deployable
artifact from the Admin application. It presents programme content, entity
catalogue/map views, map-picked new point and existing-candidate proposals, profile editing
and images, published award and level listings with award requests, and activation/QSO workflows through the Gateway. Domain data,
callsign authorization, and eligibility decisions remain owned by the APIs.

The source is under `web/`. Build its image from this directory with:

```sh
docker build -t myota/participant:dev .
```

Deployment integration and route-by-route behavioral parity remain open. The
public programme selector, content, and entity catalogue have an initial
Chromium browser check with intercepted API responses. The current activation
flow is also browser-checked through sign-in, activation start, QSO entry, and
close. Profile, image, and award workflows still need browser-level
compatibility coverage.
