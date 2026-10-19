# MyOTA Admin

This Vue 3 application is carried forward from the MyOTA monorepo baseline at
`a3a56fe82334f17de7700fe8f9bee5acc7e44982`. It remains a separate browser
application and calls the platform APIs through the Gateway. Authorization and
domain decisions remain in the owning services.

Install dependencies and start the Vite development server from this directory:

```sh
npm ci
npm run dev
```

Vite serves port 8090 and proxies `/v1` requests to `http://localhost:8080`.
Run `npm run lint`, `npm run typecheck`, and `npm run build` before packaging.
The root GitHub Actions workflow runs these checks.

The application vendors pinned Leaflet, MarkerCluster, and Geoman assets under
`public/vendor`. Keep their licensing and the OpenStreetMap tile usage policy
when updating maps.
