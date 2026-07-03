<h1 align="center">Deploy WPBot on FlowEngine</h1>
<p align="center">Your WhatsApp Groupchat Moderator, always on.</p>

<p align="center">
  <a href="https://flowengine.cloud/deploy/wpbot">
    <img src="https://flowengine.cloud/button.svg" alt="Deploy on FlowEngine" height="40">
  </a>
</p>

---

## Why FlowEngine

WPBot holds a **live WhatsApp connection** — the moment it goes offline, moderation stops and messages are missed. A laptop or a serverless function can't keep that socket alive. FlowEngine can.

- 🟢 **Always on** — runs as a persistent app, not a request/response function. The WhatsApp socket stays connected 24/7.
- 🔁 **Auto-restart** — if the process crashes or the box reboots, FlowEngine brings it straight back and it reconnects.
- 🤖 **Any AI provider** — set it in the app under **Settings**: paste an OpenAI-compatible key (or your FlowEngine gateway key). Models are fetched live from the provider, nothing is hardcoded.
- 📜 **Logs & metrics** — see connection status, moderation actions, and errors from the FlowEngine dashboard.
- 🔒 **Your data stays put** — messages live in the app's own SQLite volume and auto-expire. Nothing is shipped to a third party.

## Before you start

- A **dedicated WhatsApp number** (a burner — never your personal line). For the Gatekeeper's approve/remove to work, this number must be a **group admin**.
- Your FlowEngine account.

## Deploy in 2 steps

**1. Click Deploy on FlowEngine.**
The [deploy page](https://flowengine.cloud/deploy/wpbot) creates your instance from the pre-built `flowenginecloud/wpbot:latest` image — no build step. All env vars below are optional.

**2. Deploy.**
Hit deploy. When it's live, open the app URL and create your account.

### Optional environment variables

| Variable | Value |
|---|---|
| `AI_BASE_URL` | OpenAI-compatible endpoint to preconfigure (or leave blank and add it in **Settings**) |
| `AI_API_KEY` | key for that endpoint |
| `PORT` | `3000` |
| `MESSAGE_TTL_HOURS` | `48` |

Skip them all and set your AI provider from **Settings** in the app after deploy.

## Connect

1. Open your app URL and **create your account** (first visit lets you choose a username + password).

   ![Sign up](images/signup.png)

2. On **Connect**, scan the QR with your burner number: WhatsApp → **Linked devices** → **Link a device**.
3. Pick your groups, turn on **Spam Moderator**, **Gatekeeper**, and/or **Daily Digest**. Done.

## Keeping the session alive

FlowEngine keeps the container running, and WPBot auto-reconnects on drops. The WhatsApp login (device credentials) is stored in the app's `auth/` volume — **enable a persistent volume** for `auth/` and `data.db` so a redeploy doesn't force you to re-scan the QR.

## Scaling to many numbers

One app = one WhatsApp number. To run WPBot for many clients, deploy one app per number, or swap the transport ([src/transport/](../src/transport/)) for a WAHA/Evolution adapter that manages multiple sessions. Product logic doesn't change.
