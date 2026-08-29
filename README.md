# Tibotokens

## Local setup

The server requires Node.js 22. Install its development-only compiler dependencies:

```bash
cd server
npm ci
```

Local placeholder credentials live in the ignored `server/.env.local` file. Replace the two token values there with real credentials before use. The server needs only the X bearer token, not the consumer key or consumer secret.

The required values are:

```text
X_BEARER_TOKEN
X_USERNAME=thsottiaux
OPENROUTER_API_KEY
OPENROUTER_MODEL=openai/gpt-5.6-sol
MANUAL_CHECK_TOKEN=local-development-token-change-me
POLL_INTERVAL_MS=300000
```

`MANUAL_CHECK_TOKEN` protects the paid manual-check endpoint. Use the same private value when building the Mac app and configuring Render; generate a long random value for production. `PORT` is optional locally and defaults to `3000`. Starting the server calls the paid X and OpenRouter APIs; tests use mocked HTTP only.

## Build and run

```bash
cd server
npm test
npm start
```

`npm start` compiles the TypeScript server before launching it. The terminal logs startup, each completed poll and current phase, polling failures, and any post skipped after repeated invalid classifier output. `GET /status` shows the current full state, including the model's 0–100 likelihood of a new reset in the next 24 hours.

Build the macOS 13+ menu-bar app with the status endpoint embedded in its copied `Info.plist`:

```bash
cd mac
TIBOTOKENS_STATUS_URL=http://127.0.0.1:3000/status ./build_app.sh
open .build/app/Tibotokens.app
```

The menu's **Check Tibo** submenu can scan either the past 24 hours or past 3 days. Manual checks are paginated, leave the normal polling bookmark untouched, and may make paid X and OpenRouter calls.

For a production build, use the deployed HTTPS `/status` URL and the same manual-check token stored in Render:

```bash
TIBOTOKENS_STATUS_URL=https://SERVICE.onrender.com/status \
TIBOTOKENS_MANUAL_CHECK_TOKEN=YOUR_LONG_RANDOM_TOKEN \
./build_app.sh
```

## Render deployment

Create one Blueprint from the repository's `render.yaml`. The Blueprint uses the smallest paid `starter` web service in Frankfurt, one instance, and `/health` for health checks. Enter `X_BEARER_TOKEN`, `OPENROUTER_API_KEY`, and `MANUAL_CHECK_TOKEN` as Render secrets; the remaining values are in the Blueprint.

After deployment:

```bash
curl https://SERVICE.onrender.com/health
curl https://SERVICE.onrender.com/status
```

The Render service has not yet been provisioned.

## Current limitations

- State is memory-only. A restart reconstructs it from the latest 10 posts.
- External API failures retain the last successful state and checked time.
- The Mac app is ad-hoc signed for local use, not Developer ID signed or notarized, and has no launch-at-login, automatic updates, or App Store packaging.
