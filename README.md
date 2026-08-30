<p align="center">
  <img src="assets/tibotokens_readme_logo.png" width="128" alt="Tibotokens logo">
</p>

<h1 align="center">Tibotokens</h1>

Tibotokens watches [@thsottiaux](https://x.com/thsottiaux) for hints that a Codex usage reset is coming and shows the result in the macOS menu bar.

## Run locally

Requires macOS 13 or newer. The app uses the shared Tibotokens service, so no API keys or local server are required.

```bash
cd mac
./build_app.sh
open .build/app/Tibotokens.app
```

## Self-hosting

Create a Render Blueprint from `render.yaml` and add these two secrets:

- `X_BEARER_TOKEN` — your app-only Bearer Token from the [X Developer Console](https://console.x.com/).
- `OPENROUTER_API_KEY` — create one on [OpenRouter’s API Keys page](https://openrouter.ai/settings/keys).

Then build the app against your service:

```bash
TIBOTOKENS_STATUS_URL=https://SERVICE.onrender.com/status \
mac/build_app.sh
```

The server watches `thsottiaux`, catches up on the previous three days after a restart, and polls every two hours except from 1:00–7:00 a.m. San Francisco time. It keeps the strongest relevant signal from a rolling 72-hour window, estimates a San Francisco reset window when a post gives a timing clue, and uses `openai/gpt-5.6-sol`. Run `npm test` from `server` for its mocked test suite.
