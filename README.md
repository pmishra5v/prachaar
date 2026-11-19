# Prachaar AI CMO

A demo of the AI CMO for Indian auto-parts distributors. It's one small Node.js service with no dependencies:

- `public/index.html`: the chat app (sample distributor data, simulated sending)
- `server.js`: serves the app and forwards chat turns to Gemini on Vertex AI. It signs in as the Cloud Run service account, or as your own gcloud login when run locally.

AI: **Gemini 3.8 Flash** (Google's global endpoint). If it's busy, the app switches to **Gemini 2.5 Flash in Mumbai** for 60 seconds. If both fail, the chat answers in scripted demo mode.

## Its own codebase

Prachaar is developed on its own, separate from AdMunch. This repository holds only the Prachaar demo; AdMunch has its own code in the `admunch` repository, and nothing is shared between them. A change here never affects AdMunch, and the other way round.

| | |
| --- | --- |
| Google Cloud project | `personalproject-507904` |
| Cloud Run service | `prachar-ai-cmo` (Mumbai, asia-south1), app at `/`, open to anyone with the link |
| Data | Firestore document `prachar/svas-main` |
| WhatsApp, Facebook, Instagram | Simulated (nothing is sent) |

## Test data (anonymised InsiTE dump)

The app loads `dataset/insite-demo.json`: 846 real parts, stock and 745 invoices (8 May to 11 Aug 2026) from the InsiTE database, anonymised:

- **Prices:** each part has its own random factor between -10% and +10%. Past invoices use the same factor.
- **Stock:** each inventory row has its own random change between -10% and +10%.
- **People:** all customer, staff and store names, phones and addresses are made up. Addresses are real localities near pincode 500095, with invented streets. Phones start with 5, so they can't reach real people. Password hashes are removed.

`dataset/insite-demo.xlsx` has the same data for Excel: Parts, Inventory, Customers, Orders, Order_Items, Users, Store, and a README sheet.

To rebuild from a newer dump (needs Python 3 with openpyxl):

```powershell
python tools\anonymize_insite.py "C:\path\to\InsiteProd.sql" --out dataset
```

This dataset is the app's starting data; **Reset demo** returns to it. Saved campaigns and offers are kept when you rebuild the dataset, because part codes stay the same. The app needs `dataset/insite-demo.json` to start.

**Note:** the public URL is open to anyone with the link, and the part list and sales patterns are still your client's real business (prices changed by up to 10%).

## Voice (Sarvam AI)

Tap **Talk** (the mic next to Send) and the chat becomes a spoken conversation until you tap **End voice** or press Esc:

1. **Listening:** speak normally. When you pause for about a second, your words are sent (clips are limited to 25 seconds).
2. **Thinking:** your words appear in the chat and the AI does its work, including discounts and drafts, as usual.
3. **Speaking:** the reply is read aloud. **Skip** cuts it short.
4. Then it listens again on its own.

In voice mode the AI answers in 1–3 short spoken sentences, in the language you spoke. Telugu and Hindi replies use their own script and voice. Full details, drafts and prices stay on screen, and sending a campaign still needs a tap on **Approve & send**.

- Speech to text: Sarvam `saaras:v4` with language auto-detect, given the 50 most common part names and bike models so it hears them correctly.
- Text to speech: Sarvam `bulbul:v3`, limited to the first ~600 characters of a reply.
- Price as published: about Rs 0.50 per minute of speech, Rs 3 per 1,000 characters read aloud.
- The key never goes to the browser or into the code:
  - Locally, `start-local.ps1` asks for it once and saves it in `%USERPROFILE%\.prachaar\sarvam.key`, readable only by your Windows account. To change it, run with `-ResetVoiceKey`; to start without voice, use `-NoVoice`.
  - On Cloud Run, `deploy.ps1` copies that file into Secret Manager as `sarvam-api-key`. After changing the key, run it with `-UpdateVoiceKey`.
- Without a key, voice mode uses the browser's own recognition and voices (Chrome and Edge only).
- Recordings are not stored by Prachaar. They go to Sarvam for transcription only.

## 1. Test on your computer first

```powershell
cd "$env:USERPROFILE\Desktop\prachaar-ai"
powershell -ExecutionPolicy Bypass -File .\start-local.ps1
```

- The script checks for Node.js (installing it if missing) and **lists the ports already in use**. It then picks a free one: 8080, 8081, 8085 and so on.
- It uses your `gcloud auth login`, so it needs no keys. It's only reachable from your computer (127.0.0.1).
- The browser opens automatically. **Every AI step is logged in the window**, for example `[gemini] gemini-3.8-flash@global 1200ms → tool:create_campaign_draft`.

In a second PowerShell window, run `.\test-local.ps1`. It checks the connection to the AI and prints a list of chat messages to try.

Options: `-Port 8085`, `-Model "gemini-2.5-flash"`, `-Fallback ""` (no backup), `-NoAI` (demo mode only).

## 2. Deploy to Google Cloud Run (Mumbai)

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

The script prints the public URL. Options: `-Model "gemini-2.5-flash" -GeminiRegion asia-south1` (keeps AI processing in India), `-Provider claude` (only once the Claude quota is approved).

## Checking a live deployment

```powershell
gcloud run services logs read prachar-ai-cmo --region asia-south1 --limit 30
```

## Where data is kept

| What | Local (`start-local.ps1`) | Cloud Run (`deploy.ps1`) |
| --- | --- | --- |
| Campaigns and offers | `data\svas-main.json` in this folder | Firestore (Native mode) in Mumbai, document `prachar/svas-main` |
| Chat history | This browser only (localStorage) | This browser only (localStorage) |

**Reset demo** clears both. The demo has one shared store, so everyone who opens the public URL sees the same campaigns. A real product needs a login and separate data for each distributor.

## Limits

- 200 AI calls per visitor every 10 minutes (one chat message uses 3-5 calls).
- 3,000 AI calls a day in total.
- At most 2 Cloud Run instances; scales to zero when idle.
