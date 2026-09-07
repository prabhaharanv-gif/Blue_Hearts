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
- Stays signed in: locking the screen or closing the app is not a log out. Only the log out button ends the session
- Live messages over WebSocket (Socket.IO)
- Header shows the other person's name with **Online**, **typing…**, or **last seen** underneath — never a "connecting" or "offline" placeholder
- Sent ✓, delivered ✓✓, read ✓✓ (blue) ticks
- Reply to a message (double-click a bubble, or the ↩ button)
- Edit your own message (the ✎ button) — it changes on both screens and is marked *edited*
- Send photos, video, audio and files (📎, or paste a screenshot, or drag one in) — tap a photo for full size
- Emoji picker, dark mode, sound + unread count when the tab is in the background
- Notification banners when a message lands while you are elsewhere (see below)
- "Clear chat" wipes both screens instantly
- Third person is refused with "Not allowed."

### Sending attachments

Anything up to **10 MB** goes through. Photos are redrawn to 1600px on the long
edge before they leave the browser, so a 6 MB phone picture arrives as a couple
of hundred KB; GIFs are left alone so they keep moving. Anything still over the
limit is refused on your own screen and never sent.

Pick several files at once and each becomes its own message — whatever you had
typed rides along as the caption on the first.

### Notifications

Tap the bell in the header once and allow the permission prompt; the banner
then appears whenever a message arrives while the app is not the thing on
screen. Three different mechanisms sit behind that one switch, because no
single one works everywhere: the packaged Android app raises the banner
through Capacitor, Android browsers raise it from the service worker, and
desktop browsers use the plain notification. Whichever answers is used.

Tapping the bell again silences it. Silenced means silenced: no banner, no
blip, and any banner already sitting in the notification shade is pulled back
as the switch goes off. Messages still arrive and still count up in the tab
title — they just do it quietly. The setting is per device and survives a
restart, so an app that was silenced when you closed it comes back silenced.

The app has to be running for a banner to appear — in the foreground, or in
the background before Android has stopped it. There is no push server, so a
message that arrives after the system has killed the app is waiting in the
chat rather than announced on the lock screen.

The packaged build needs a rebuild to pick the plugin up:

```bash
npx cap sync android
```

## No storage — how

- The server keeps only the two connected names in RAM. Message text is relayed to the other socket and never held.
- Attachments are relayed the same way: the bytes pass straight from one socket to the other and are never decoded, written down, or cached.
- No database, no files, no logs of message content.
- The browser holds messages in memory only, and shows attachments from `blob:` URLs that it releases on "Clear chat" and on log out. Nothing reaches your downloads folder unless you save it yourself.
- Refresh, and the conversation is gone from both sides.
- Three small things are saved locally, in this browser or phone only: your light/dark preference, your notification switch, and — so that closing the app is not a log out — the name and booking reference you signed in with. Logging out deletes the last of these. None of it is ever sent anywhere the sign-in itself does not already go.
- The server remembers one thing across a socket: when each name was last connected, so the header can say "last seen". Names and times only, in RAM, gone when the process restarts.

Over HTTPS on Render, traffic is encrypted in transit. It is **not** end-to-end encrypted — the server relays plaintext in memory. Fine for private chat, not for secrets you'd protect from the host.

## Files

| File | What it is |
| --- | --- |
| `server.js` | Express + Socket.IO relay, passcode check, 2-person limit |
| `public/index.html` | Login screen + chat shell |
| `public/style.css` | WhatsApp-like theming, light and dark |
| `public/app.js` | Client logic: messages, ticks, typing, replies |
| `render.yaml` | Render deploy config |
