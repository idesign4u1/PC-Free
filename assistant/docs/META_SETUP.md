# Meta WhatsApp Setup

**What you get at the end:** a dedicated WhatsApp number that talks to your
assistant.

You need a phone number that is **not** already registered to WhatsApp or
WhatsApp Business. A second SIM, an eSIM, or a landline that can receive an SMS
or a voice call all work. Once registered to the Cloud API, that number can no
longer be used in the normal WhatsApp app.

> This uses the official **Meta WhatsApp Business Platform (Cloud API)** only.
> No WhatsApp Web automation, no Selenium, no unofficial gateways.

---

## 1. Meta app

1. Go to **https://developers.facebook.com/apps** → **Create app**.
2. Use case: **Other** → app type: **Business**.
3. Name it (e.g. `Shay AI Assistant`) and pick your Business portfolio. Create
   one if you have none — you do not need a verified business to start testing.
4. On the app dashboard, find **WhatsApp** and click **Set up**.

**Copy now:**

| Where | Value | → `.env` |
|---|---|---|
| App dashboard → App settings → Basic → **App ID** | numeric | `META_APP_ID` |
| Same page → **App secret** → *Show* | long hex string | `META_APP_SECRET` |

`META_APP_SECRET` is what verifies that inbound webhooks really came from Meta.
Treat it like a password.

---

## 2. Phone number

In **WhatsApp → API Setup**:

1. Under **From**, either use the Meta-provided test number (fine for the first
   day; it can only message up to 5 pre-approved recipients) or click
   **Add phone number** to register your real dedicated number.
2. To register a real number: enter it, choose SMS or voice verification, enter
   the code, and set the display name (`Shay AI Assistant`). Display names go
   through a short review.

**Copy now:**

| Where | Value | → `.env` |
|---|---|---|
| API Setup → **Phone number ID** (under the From selector — the long numeric id, *not* the phone number) | e.g. `123456789012345` | `WHATSAPP_PHONE_NUMBER_ID` |

Also add **your own** personal WhatsApp number under **To → Manage phone number
list** while you are on a test number, otherwise the assistant cannot reply to
you.

Put your own number in `.env` as `BOOTSTRAP_USER_PHONE`, in E.164 digits with
no `+` (e.g. `972501234567`). Only this number is allowed to command the
assistant; anything else is logged and dropped.

---

## 3. Access token

The temporary token on the API Setup page expires in 24 hours. Get a permanent
one:

1. **https://business.facebook.com/settings** → **Users → System users**.
2. **Add** → name it `assistant-bot`, role **Admin** → Create.
3. **Add assets** → **Apps** → select your app → enable **Manage app** → Save.
4. **Add assets** → **WhatsApp accounts** → select your WABA → enable
   **Manage** → Save.
5. **Generate new token** → select your app → token expiration **Never** →
   permissions: **`whatsapp_business_messaging`** and
   **`whatsapp_business_management`** → Generate.

**Copy now — it is shown once:**

| Value | → `.env` |
|---|---|
| The generated token | `WHATSAPP_ACCESS_TOKEN` |

---

## 4. Webhook

The assistant must be reachable over **HTTPS**. Locally, use a tunnel:

```bash
ngrok http 3000          # or: cloudflared tunnel --url http://localhost:3000
```

Put the tunnel URL in `.env` as `APP_URL` (no trailing slash) and restart the app.

Invent a verify token — any random string — and set it as
`WHATSAPP_VERIFY_TOKEN` in `.env`:

```bash
openssl rand -hex 16
```

Then in **WhatsApp → Configuration → Webhook → Edit**:

| Field | Value |
|---|---|
| Callback URL | `https://<your-domain>/webhooks/whatsapp` |
| Verify token | the same string as `WHATSAPP_VERIFY_TOKEN` |

Click **Verify and save**. Meta immediately GETs the URL; your log should show
`whatsapp webhook verified`. If it fails, the app is not running, `APP_URL` is
wrong, or the tokens differ.

Then click **Manage** next to *Webhook fields* and subscribe to **`messages`**.
That single field covers inbound text, voice notes, button taps and delivery
statuses. Subscribe to nothing else.

---

## 5. Message template (for reminders)

Meta's rule: when a user messages you, a **24-hour customer service window**
opens, and each new message from them resets it. Inside the window you can send
free-form messages, including interactive buttons. Once it closes, only a
pre-approved **template** may be sent.

In practice you will message the assistant most days, so most reminders land
inside the window. For the ones that do not, create a template:

1. **https://business.facebook.com/wa/manage/message-templates** → **Create template**.
2. Category **Utility** (not Marketing — Utility is for transactional
   notifications like reminders and is approved faster).
3. Name: `task_reminder`. Language: **Hebrew**.
4. Body:
   ```
   🔔 תזכורת: {{1}}
   ```
   Sample for `{{1}}`: `לשלוח הצעה לדני`
5. Submit. Approval usually takes minutes to a few hours.

Then set:

```env
WHATSAPP_TEMPLATE_REMINDER_NAME=task_reminder
WHATSAPP_TEMPLATE_LOCALE=he
```

Leave it empty until approved: without a template the app **defers**
out-of-window reminders and retries hourly rather than failing. It never drops
one.

> **Billing note:** Meta announced that from **1 October 2026**, Utility
> templates and service messages sent inside the 24-hour window — currently
> free — become billable. Volumes here are tiny (a handful of messages a day),
> but check current pricing before assuming zero cost.

---

## 6. Verify it works

```bash
curl "https://<your-domain>/health"
```

`capabilities.whatsapp` should be `true`. Then send your assistant number:

```
תזכיר לי בעוד שעה להתקשר לדני
```

You should get `✅ הוספתי: להתקשר לדני` within a couple of seconds.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Webhook verification fails | App not running, `APP_URL` mismatch, or the verify token differs |
| `401 invalid signature` in the log | `META_APP_SECRET` is wrong, or a proxy is rewriting the request body |
| Messages arrive, no reply | Your number is not `BOOTSTRAP_USER_PHONE` (check the log for `inbound from an unregistered number`) |
| `(#131030) Recipient not in allowed list` | Test number: add your number under **To → Manage phone number list** |
| `(#131047) Re-engagement message` | The 24-hour window closed and no template is configured |
| Token stops working after a day | You are using the temporary token — create the System User token in step 3 |
