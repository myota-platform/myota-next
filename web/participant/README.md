# MyOTA Participant

This is the baseline static participant client, kept as a separate deployable
artifact from the Admin application. It presents programme content, entity
catalogue/map views, profile editing and images, and award workflows through
the Gateway. Domain data and eligibility decisions remain owned by the APIs.

The source is under `web/`. Build its image from this directory with:

```sh
docker build -t myota/participant:dev .
```

The current client does not expose activation or QSO entry workflows. Deployment
integration and route-by-route API parity remain open.
