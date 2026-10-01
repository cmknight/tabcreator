# TabCreator

## Deploy

The site is published to GitHub Pages by the `deploy` job in `.github/workflows/ci.yml`. It runs
only on pushes to `main`, after every other CI job passes, and publishes the `app/dist` that the
`app` job built and checked. Pull requests and other branches never deploy.

One-time setup by the repository owner: Settings → Pages → Build and deployment → Source:
**GitHub Actions**. Until then the `deploy` job fails on `main` while the rest of CI stays green.
