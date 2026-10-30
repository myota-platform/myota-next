# MyOTA Participant

This is the baseline static participant client, kept as a separate deployable
artifact from the Admin application. It presents programme content, entity
catalogue/map views, map-picked new point and existing-candidate proposals, profile editing
and images, published award and level listings with award requests, and activation/QSO workflows through the Gateway. Domain data,
callsign authorization, and eligibility decisions remain owned by the APIs.
Participants can also upload an ADIF log to an open activation and follow its
processing status and accepted/rejected record counts.

The programme map requests at most 500 features across the visible tiles at a
time. Dense areas show a zoom-in prompt. The Geodata API simplifies display
geometry by zoom level while preserving the stored entity geometry.

Public registration requires a callsign for licensed operators. SWL
registrations omit the callsign field. A newly registered operator's callsign
is recorded as self-asserted and unverified until account verification is
completed through the existing callsign evidence workflow.

The source is under `web/`. Build its image from this directory with:

```sh
docker build -t myota/participant:dev .
```

Deployment qualification and route-by-route behavioral parity remain open. The
public programme selector, content, and entity catalogue have an initial
Chromium browser check with intercepted API responses. The current activation
flow is also browser-checked through sign-in, activation start, QSO entry, and
close, profile details editing, image crop/upload, and an eligible award
request. Existing-candidate and map-picked point proposals are covered; broader
accessibility, responsive behavior, and service integration still need review.
