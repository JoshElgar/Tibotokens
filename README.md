<p align="center">
  <img src="assets/tibotokens_readme_logo.png" width="128" alt="Tibotokens logo">
</p>

<h1 align="center">Tibotokens</h1>

Tibotokens watches [@thsottiaux](https://x.com/thsottiaux) for hints that a Codex usage reset is coming and shows the result in the macOS menu bar.

## Run locally

Requires Node.js 22 and macOS 13 or newer.

```bash
cp server/.env.example server/.env.local
# Add the three secrets to server/.env.local, then:
cd server
npm ci
npm start
```

```bash
cd mac
./build_app.sh
open .build/app/Tibotokens.app
```

Run `npm test` from `server` for the mocked test suite. Starting the server or using a manual check can call paid X and OpenRouter APIs.

## Deploy

Create a Render Blueprint from `render.yaml` and add `X_BEARER_TOKEN`, `OPENROUTER_API_KEY`, and `MANUAL_CHECK_TOKEN` as secrets. Then build the app against the deployed service:

```bash
TIBOTOKENS_STATUS_URL=https://SERVICE.onrender.com/status \
TIBOTOKENS_MANUAL_CHECK_TOKEN=YOUR_LONG_RANDOM_TOKEN \
mac/build_app.sh
```

The server always watches `thsottiaux`, polls every 15 minutes by default, and uses `openai/gpt-5.6-sol`. Change the frequency from the app’s **Options** menu. Render supplies `PORT`; locally it defaults to `3000`.
