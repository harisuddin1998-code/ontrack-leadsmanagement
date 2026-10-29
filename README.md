# On Track Lead Management

Routes every ad click to the next active sales member's WhatsApp, tracks leads, and shows a live dashboard.

- `/go` is the ad destination. Each click goes to the next active member via `wa.me` with a pre-filled "Ref #id" message.
- `/` is the admin dashboard (HTTP basic auth: `DASH_USER` / `DASH_PASS`).
- `/agent/<token>` is each member's private lead page.
- Members can link their WhatsApp by QR (unofficial, read-only) so the customer's number is captured automatically.

## Run

```
npm install
cp .env.example .env   # set DASH_USER and DASH_PASS
npm start
```

Data lives in `/data` when that volume exists, otherwise the project folder (`DATA_DIR` / `DB_PATH` override).

The WhatsApp Cloud API bot (`bot.js`, `whatsapp.js`, `/webhook`) is optional and off unless its keys are set.
