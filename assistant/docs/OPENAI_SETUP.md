# OpenAI Setup

**What you get:** the assistant understands free-form Hebrew, and transcribes
voice notes. One key covers both.

---

## 1. Key

1. **https://platform.openai.com/api-keys** → **Create new secret key**.
2. Name it `shay-assistant`. Copy it — it is shown once.
3. Make sure the account has credit: **Settings → Billing**. A new project with
   a zero balance returns `429 insufficient_quota`, which reads like a rate
   limit but is not.

```env
AI_PROVIDER=openai
AI_API_KEY=sk-...
```

That is the whole required configuration. `STT_PROVIDER` defaults to `auto`, so
voice notes start working from the same key with nothing else set.

---

## 2. Model

Leave `AI_MODEL` blank and you get the current default, **`gpt-5.6-terra`**.

| Model id | Rough cost (in/out per 1M) | When |
|---|---|---|
| `gpt-5.6-luna` | $0.20 / $1.20 | Cheapest. Fine for straightforward phrasing |
| `gpt-5.6-terra` | $2 / $12 | **Default.** Balanced for Hebrew with English mixed in |
| `gpt-5.6-sol` | $5 / $30 | Harder, more elliptical sentences |
| `gpt-6-astra` | $10 / $50 | Strongest; overkill for intent classification |
| `gpt-5`, `gpt-5-mini` | $1.25 / $10, $0.25 / $2 | Previous generation, still served |

Model ids change. **Confirm yours actually answers** before assuming it works:

```bash
curl -s localhost:3000/api/ai-check -H "authorization: Bearer $ADMIN_TOKEN" | jq
```

```json
{ "ok": true, "provider": "openai", "configuredModel": "gpt-5.6-terra",
  "respondingModel": "gpt-5.6-terra", "latencyMs": 812 }
```

A wrong key or a retired id comes back as `ok: false` with the API's own error
message. Without this check the failure is invisible: the assistant silently
falls back to the deterministic rules and just seems a bit dim.

To list what your account can actually reach:

```bash
curl -s https://api.openai.com/v1/models -H "authorization: Bearer $AI_API_KEY" \
  | jq -r '.data[].id' | grep -E '^gpt' | sort
```

---

## 3. What it actually costs

Most messages never reach the model. The deterministic rules handle reminders,
deadlines, completions, snoozes, list and calendar questions — `/api/message`
reports `resolvedBy: "rules"` when that happened. The model sees only the
sentences the rules decline to guess at.

For one person that is a few hundred short calls a month: cents on `terra`,
fractions of a cent on `luna`. Voice transcription is billed by audio minute.

To watch it, the `ai_interactions` table records the provider, model, latency
and token counts for every call:

```sql
SELECT model, count(*), sum(input_tokens), sum(output_tokens)
FROM ai_interactions WHERE created_at > now() - interval '7 days'
GROUP BY model;
```

---

## 4. Voice notes

`STT_MODEL` defaults to `gpt-4o-transcribe`, which handles Hebrew with English
technical terms noticeably better than the legacy `whisper-1`. Use
`gpt-4o-mini-transcribe` if you want it cheaper.

The transcription request carries a Hebrew domain hint, which is what keeps
`Google Ads`, `campaign` and `deadline` from being mangled into Hebrew
phonetics.

---

## Notes on the integration

- **Structured outputs, strict mode.** Every request pins a JSON Schema with
  `strict: true`, so the reply is machine-checkable rather than prose to be
  regex'd. It is then validated again with Zod before anything is dispatched.
- **The schema is rewritten for OpenAI.** Strict mode accepts a small subset of
  JSON Schema and rejects the entire request on an unsupported keyword —
  `minimum`, `maximum`, `pattern`, `format` and friends. `ai/openai-schema.ts`
  strips those and rewrites nullable unions as `anyOf`. Nothing is lost: the
  ranges are enforced by Zod on the way back, and out-of-range numbers are
  clamped rather than rejected.
- **Refusals are handled.** A refused request is an HTTP 200 with
  `message.refusal` set and `content` null. It is detected and turned into a
  "rephrase that?" reply, not a crash.
- **Truncation is named.** Hitting `AI_MAX_TOKENS` reports itself as truncation
  rather than as invalid JSON.
- **Switching back to Anthropic** is two lines — `AI_PROVIDER=anthropic` and an
  `sk-ant-...` key. Nothing outside `src/ai/` knows which provider is in use.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `429 insufficient_quota` | No credit on the account. It is billing, not rate limiting |
| `401 Incorrect API key` | Key revoked, or belongs to a different organisation |
| `404 The model ... does not exist` | Retired or unavailable id — list your models with the curl above |
| `400 Invalid schema` | Report it: the adapter missed a keyword. `tests/openai-schema.test.ts` is where the fix belongs |
| Replies are basic and `/api/ai-check` fails | The assistant is running on the rules path alone; fix the key or model first |
| Voice notes ignored | `capabilities.stt` in `/health`. With `AI_PROVIDER=openai` it should be true automatically |
