# Microsoft Setup (Outlook Calendar + Mail)

**What you get:** Outlook calendar events merged with Google in a single
answer, and action items spotted in Outlook mail.

Works with a personal Microsoft account (outlook.com, hotmail.com, live.com) or
a work/school account. Mail permission is **read-only**.

---

## 1. Register the application

1. **https://entra.microsoft.com** → **Applications → App registrations** →
   **New registration**.
   (Or **https://portal.azure.com** → *Microsoft Entra ID* → *App registrations*.)
2. Fill in:

| Field | Value |
|---|---|
| Name | `Shay AI Assistant` |
| Supported account types | **Accounts in any organizational directory and personal Microsoft accounts** |
| Redirect URI | Platform **Web** → `https://<your-domain>/oauth/microsoft/callback` |

3. **Register**.

The account-types choice matters: pick the "any organizational directory **and**
personal" option and leave `MICROSOFT_TENANT=common`. A single-tenant
registration will reject a personal outlook.com account.

**Copy now:**

| Where | Value | → `.env` |
|---|---|---|
| Overview → **Application (client) ID** | GUID | `MICROSOFT_CLIENT_ID` |

---

## 2. Client secret

1. **Certificates & secrets → Client secrets → New client secret**.
2. Description `assistant`, expiry **24 months** (the maximum; note the date —
   the connection stops working when it lapses).
3. **Add**.

**Copy the `Value` column immediately** — not the Secret ID, and it is only
shown once.

| Value | → `.env` |
|---|---|
| Secret **Value** | `MICROSOFT_CLIENT_SECRET` |

---

## 3. Permissions

**API permissions → Add a permission → Microsoft Graph → Delegated permissions**.

Add exactly these:

| Permission | Why |
|---|---|
| `Calendars.ReadWrite` | Read events and create them |
| `Mail.Read` | Detect action items. Read-only — no send, no modify |
| `User.Read` | Read the signed-in account's own address |
| `offline_access` | Issue a refresh token |
| `openid`, `email`, `profile` | Sign-in |

Use **Delegated**, never Application permissions — the assistant acts as you,
not as a service with tenant-wide mailbox access.

You do **not** need "Grant admin consent" for a personal account. On a work
account where the tenant requires admin consent, an administrator must click it
once.

---

## 4. Connect

Set in `.env`:

```env
MICROSOFT_CLIENT_ID=<application client id>
MICROSOFT_CLIENT_SECRET=<secret value>
MICROSOFT_TENANT=common
```

Restart, then open:

```
https://<your-domain>/oauth/microsoft/start
```

Sign in and accept. The confirmation page shows the connected address and the
number of calendars found.

Test from WhatsApp — with both providers connected you should now get one
merged answer:

```
מה יש לי היום?
```

```
📅 היום

09:00  פגישה עם דני
   Google

11:30  הרצאה
   Outlook

14:00  שיחת Zoom
   Google
```

---

## Notes

- **Deduplication.** An invitation accepted in one account and mirrored into the
  other appears once. Matching is by `iCalUID` first, then by identical
  start/end plus a normalised title.
- **Times.** Graph returns naive local date-times plus a separate `timeZone`
  field. The client sends `Prefer: outlook.timezone="UTC"` and parses
  explicitly as UTC — parsing those strings as local time silently shifts every
  event.
- **Recurring events.** The client uses `/calendarView`, not `/events`, so
  recurring series are expanded into real instances.
- **Secret expiry.** Diarise the date. When it lapses, `/health/full` shows the
  connection as `needs_reauth`; create a new secret and reconnect.
- **Revoking.** https://account.live.com/consent/Manage (personal) or the Entra
  portal (work).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `AADSTS50011` redirect mismatch | The registered URI differs from `APP_URL` + path |
| `AADSTS700016` app not found in tenant | Single-tenant registration with a personal account — re-register with "any directory and personal" |
| `AADSTS7000215` invalid client secret | You copied the Secret ID instead of the Value |
| `AADSTS65001` consent required | Accept the prompt, or have an admin grant consent on a work tenant |
| Events an hour out | Something is stripping the `Prefer` header — check for an intermediate proxy |
