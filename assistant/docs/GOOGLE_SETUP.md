# Google Setup (Calendar + Gmail)

**What you get:** the assistant can read your Google Calendar, create events in
it, and spot action items in your Gmail.

Scopes are least-privilege: calendar is read/write because the assistant creates
events; **Gmail is read-only** — the assistant never sends, replies to, deletes
or modifies mail.

---

## 1. Project and APIs

1. **https://console.cloud.google.com/projectcreate** → name it
   `shay-ai-assistant` → Create.
2. Enable both APIs (make sure the new project is selected):
   - **https://console.cloud.google.com/apis/library/calendar-json.googleapis.com** → Enable
   - **https://console.cloud.google.com/apis/library/gmail.googleapis.com** → Enable

---

## 2. OAuth consent screen

**https://console.cloud.google.com/auth/overview**

1. **Get started**.
2. App name `Shay AI Assistant`, support email: your address.
3. Audience: **External**. (Internal only exists for Workspace organisations; if
   you have one, Internal is simpler — it skips verification entirely.)
4. Contact email: your address. Agree and continue.

Then **Audience → Test users → Add users** and add your own Google address.

> **Why this matters:** an unverified External app in *Testing* mode issues
> refresh tokens that **expire after 7 days**. For a personal assistant that
> means reconnecting weekly. Two ways out: use an Internal app if you have
> Workspace, or click **Publish app** on the Audience page. Publishing with
> `gmail.readonly` normally triggers Google's verification review; for a
> single-user app you can stay in Testing and reconnect, or complete
> verification once.

Add scopes under **Data access → Add or remove scopes**:

```
openid
email
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/gmail.readonly
```

`gmail.readonly` is a restricted scope — Google will warn you. That is expected.

---

## 3. Credentials

**https://console.cloud.google.com/apis/credentials** → **Create credentials** →
**OAuth client ID**.

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | `assistant-web` |
| Authorised redirect URI | `https://<your-domain>/oauth/google/callback` |

The redirect URI must match `APP_URL` + `GOOGLE_REDIRECT_PATH` **exactly** —
scheme, host, path, no trailing slash. Add your ngrok URL too if you develop
locally, and update it whenever the tunnel changes.

**Copy now:**

| Value | → `.env` |
|---|---|
| Client ID (`…apps.googleusercontent.com`) | `GOOGLE_CLIENT_ID` |
| Client secret | `GOOGLE_CLIENT_SECRET` |

---

## 4. Connect

Restart the app, then open in a browser:

```
https://<your-domain>/oauth/google/start
```

Sign in, accept the scopes (an unverified app shows "Google hasn't verified this
app" → **Advanced → Go to Shay AI Assistant**). You should land on a page
confirming the address and the number of calendars found.

Test it from WhatsApp:

```
מה יש לי היום?
מתי אני פנוי מחר לשעה?
```

---

## Notes

- **Refresh tokens.** The authorisation request sends `access_type=offline` and
  `prompt=consent`, which is what makes Google return a refresh token. Without
  it the connection dies after an hour.
- **Which calendars.** Every calendar you can read is imported. Events are
  created on your **primary** calendar.
- **Storage.** Tokens are encrypted with AES-256-GCM under `ENCRYPTION_KEY`
  before they touch the database.
- **Revoking.** https://myaccount.google.com/permissions. The next call raises
  a re-auth error and the assistant tells you to reconnect rather than showing
  an empty calendar.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | The URI in the console differs from `APP_URL` + path — usually a trailing slash or `http` vs `https` |
| `access_denied` | Your address is not in **Test users** |
| Connection dies after ~7 days | Testing-mode refresh-token expiry (see above) |
| Calendar empty but you have events | Check `/health/full` — a token error is reported there |
