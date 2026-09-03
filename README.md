# Blue Hearts 💙

A private WhatsApp-style chat for exactly two people. Log in with a name and a shared passcode, chat, close the tab — nothing is kept.

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000. On the same Wi-Fi, the other person uses the `network` URL printed in the terminal.

To require a passcode locally:

```bash
$env:PASSCODE="our-secret"; npm start
```

Without `PASSCODE` set, the passcode field is hidden and anyone who can reach the URL can join.

## Deploy free on Render (chat from anywhere)

1. **Put the code on GitHub.** Create a new **private** repo at https://github.com/new named `blue-hearts` — don't add a README or .gitignore. Then in this folder:

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/blue-hearts.git
   git push -u origin main
   ```

2. **Create the service.** Sign in at https://render.com with GitHub → **New +** → **Web Service** → pick the `blue-hearts` repo. Render reads `render.yaml`, so build and start commands fill themselves in. Instance type: **Free**.

3. **Set the passcode.** Under **Environment**, add:

   | Key | Value |
   | --- | --- |
   | `PASSCODE` | the secret word you both agree on |

4. **Deploy.** After a minute or two you get a URL like `https://blue-hearts.onrender.com`. Send that link and the passcode to the other person — separately, not in the same message.

**Free tier note:** the service sleeps after 15 minutes with nobody connected. The next visit takes ~30 seconds to wake it, then works normally. Upgrading to the $7/mo Starter plan removes the sleep.

## Install it as an app

Blue Hearts is a PWA, so it installs to your home screen or desktop with its own icon and no browser bars. This only works over the deployed HTTPS URL, not the local `http://` one.

- **Android (Chrome):** open the URL → tap the **Install as app** button on the login screen, or menu ⋮ → **Add to Home screen**.
- **iPhone (Safari — must be Safari, not Chrome):** open the URL → Share button → **Add to Home Screen**.
- **Windows/Mac (Chrome or Edge):** open the URL → install icon in the address bar, or menu → **Install Blue Hearts**.

Once installed it opens fullscreen like any other chat app. It still needs a connection — it's a real-time chat, so there's no offline mode beyond the screen loading.

## What it does

- Name + passcode login — no accounts, no signup
- Live messages over WebSocket (Socket.IO)
- Online / typing… status in the header
- Sent ✓, delivered ✓✓, read ✓✓ (blue) ticks
- Reply to a message (double-click a bubble, or the ↩ button)
- Emoji picker, dark mode, sound + unread count when the tab is in the background
- "Clear chat" wipes both screens instantly
- Third person is refused with "Chat is full"

## No storage — how

- The server keeps only the two connected names in RAM. Message text is relayed to the other socket and never held.
- No database, no files, no logs of message content.
- The browser keeps messages in a JS array only. Refresh, and the conversation is gone from both sides.
- The only thing saved locally is your light/dark preference.

Over HTTPS on Render, traffic is encrypted in transit. It is **not** end-to-end encrypted — the server relays plaintext in memory. Fine for private chat, not for secrets you'd protect from the host.

## Files

| File | What it is |
| --- | --- |
| `server.js` | Express + Socket.IO relay, passcode check, 2-person limit |
| `public/index.html` | Login screen + chat shell |
| `public/style.css` | WhatsApp-like theming, light and dark |
| `public/app.js` | Client logic: messages, ticks, typing, replies |
| `render.yaml` | Render deploy config |
