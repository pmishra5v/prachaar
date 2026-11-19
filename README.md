# Prachar AI CMO — Cloud Run deployment

A demo of the AI CMO for Indian auto-parts distributors. It's one small Node.js service (no dependencies):

- `public/index.html`: the chat app (sample distributor data, simulated sending)
- `server.js`: serves the app and forwards chat turns to Claude (Anthropic API). The API key stays on the server.

## Deploy (about 5 minutes)

You need a Google Cloud project with billing turned on, and an Anthropic API key (console.anthropic.com).

1. Open **Google Cloud Shell**: https://shell.cloud.google.com
2. Upload `prachar-ai-cmo.zip` (⋮ menu → Upload), then run:
   ```
   unzip prachar-ai-cmo.zip && cd prachar-ai-cmo
   bash deploy.sh
   ```
3. When asked, enter your project ID and paste your Anthropic API key. The key is stored in Secret Manager.
4. The script finishes by printing **Public URL: https://prachar-ai-cmo-….a.run.app**

Region: `asia-south1` (Mumbai). To redeploy after changes, run `bash deploy.sh` again.

## Options (set before running deploy.sh)

| Variable | Default | What it does |
| --- | --- | --- |
| `ACCESS_CODE` | none | Asks visitors for a code before the AI answers, e.g. `ACCESS_CODE=svas2026 bash deploy.sh` |
| `MODEL` | `claude-haiku-4-5` | Claude model ID. Pick a larger model for better Hindi and Telugu copy. |
| `REGION` | `asia-south1` | Cloud Run region |

## Safety and cost limits in server.js

- It only accepts Prachar's own instructions and 7 tools, so it can't be used as a general chatbot.
- Limits: 60 AI calls per visitor IP every 10 minutes, and 3,000 calls a day in total (`MAX_PER_IP_10MIN` and `MAX_PER_DAY`).
- Cloud Run runs at most 2 instances and scales to zero when idle.
- If the AI backend is down, the page still works in scripted demo mode.

## Remove it

```
gcloud run services delete prachar-ai-cmo --region asia-south1
gcloud secrets delete anthropic-api-key
```
