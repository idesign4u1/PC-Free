import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  parseKey,
  verifyMetaSignature,
} from '../src/utils/crypto.js';
import { parseWebhook } from '../src/whatsapp/webhook-parser.js';
import { hashPhone, maskEmail, truncateForStorage } from '../src/utils/redact.js';
import { matchTask } from '../src/tasks/matcher.js';
import { truncateButtonTitle, MAX_BUTTON_TITLE } from '../src/whatsapp/client.js';
import type { Task } from '../src/domain/types.js';

const APP_SECRET = 'test-app-secret';

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('Meta webhook signature', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('accepts a correctly signed body', () => {
    expect(verifyMetaSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it('rejects a body that was tampered with after signing', () => {
    const signature = sign(body);
    expect(verifyMetaSignature(`${body} `, signature, APP_SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyMetaSignature(body, sign(body, 'other-secret'), APP_SECRET)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyMetaSignature(body, undefined, APP_SECRET)).toBe(false);
  });

  it('rejects when no app secret is configured', () => {
    expect(verifyMetaSignature(body, sign(body), '')).toBe(false);
  });

  it('verifies the raw bytes, not the re-serialised object', () => {
    // Re-serialising changes whitespace and therefore the digest — this is the
    // classic mistake the raw-body parser exists to avoid.
    const raw = '{"object":"whatsapp_business_account",  "entry":[]}';
    const signature = sign(raw);
    expect(verifyMetaSignature(raw, signature, APP_SECRET)).toBe(true);
    expect(verifyMetaSignature(JSON.stringify(JSON.parse(raw)), signature, APP_SECRET)).toBe(false);
  });
});

describe('token encryption at rest', () => {
  const key = parseKey(randomBytes(32).toString('base64'));

  it('round-trips a secret', () => {
    const secret = 'ya29.a0Af-refresh-token-value';
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('fails closed on a tampered ciphertext', () => {
    const payload = encryptSecret('secret', key);
    const parts = payload.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('fails closed under the wrong key', () => {
    const other = parseKey(randomBytes(32).toString('base64'));
    expect(() => decryptSecret(encryptSecret('secret', key), other)).toThrow();
  });

  it('rejects a key of the wrong length', () => {
    expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseKey('')).toThrow();
  });

  it('accepts hex as well as base64', () => {
    expect(() => parseKey(randomBytes(32).toString('hex'))).not.toThrow();
  });
});

describe('log redaction', () => {
  it('hashes phone numbers rather than logging them', () => {
    const hashed = hashPhone('972501234567');
    expect(hashed).not.toContain('972501234567');
    expect(hashed).toBe(hashPhone('972501234567'));
  });

  it('masks the local part of an email address', () => {
    expect(maskEmail('dana@client.com')).toBe('da**@client.com');
  });

  it('truncates long bodies before storage', () => {
    expect(truncateForStorage('a'.repeat(1000))).toHaveLength(501);
    expect(truncateForStorage(null)).toBeNull();
  });
});

describe('webhook parsing', () => {
  it('extracts a text message', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '999' },
                contacts: [{ wa_id: '972500000001', profile: { name: 'Shay' } }],
                messages: [
                  {
                    id: 'wamid.1',
                    from: '972500000001',
                    timestamp: '1789000000',
                    type: 'text',
                    text: { body: 'שלום' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      kind: 'text',
      text: 'שלום',
      profileName: 'Shay',
      phoneNumberId: '999',
    });
  });

  it('extracts an interactive button reply with its structured id', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.2',
                    from: '972500000001',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'done:abc12345', title: '✅ בוצע' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.messages[0]).toMatchObject({
      kind: 'button',
      buttonId: 'done:abc12345',
      text: '✅ בוצע',
    });
  });

  it('extracts a voice note', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.3',
                    from: '972500000001',
                    type: 'audio',
                    audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.messages[0]).toMatchObject({ kind: 'voice', audioMediaId: 'media-1' });
  });

  it('flags forwarded messages as untrusted input', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.4',
                    from: '972500000001',
                    type: 'text',
                    text: { body: 'הועבר' },
                    context: { forwarded: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.messages[0]!.isForwarded).toBe(true);
  });

  it('separates delivery statuses from messages', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.9',
                    status: 'failed',
                    errors: [{ code: 131_047, title: 'Re-engagement message' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.statuses[0]).toMatchObject({ status: 'failed', error: 'Re-engagement message' });
  });

  it('returns empty for a malformed payload instead of throwing', () => {
    expect(parseWebhook({ nonsense: true })).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook(null)).toEqual({ messages: [], statuses: [] });
  });
});

describe('task reference matching', () => {
  function task(title: string, id = title): Task {
    return {
      id,
      user_id: 'u',
      title,
      description: null,
      status: 'open',
      priority: 'normal',
      due_date: null,
      due_time: null,
      due_at: null,
      timezone: 'Asia/Jerusalem',
      reminder_at: null,
      source: 'whatsapp',
      source_id: null,
      source_url: null,
      source_metadata: {},
      project: null,
      client: null,
      tags: [],
      completed_at: null,
      snoozed_until: null,
      parent_task_id: null,
      recurrence: null,
      confidence_score: null,
      ai_generated: false,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  it('picks the single obvious match', () => {
    const result = matchTask('המשימה של אביב', [
      task('לשלוח הצעה לאביב'),
      task('לבדוק קמפיין של דני'),
    ]);
    expect(result.best?.title).toBe('לשלוח הצעה לאביב');
    expect(result.isAmbiguous).toBe(false);
  });

  it('refuses to choose between equally plausible matches', () => {
    const result = matchTask('המשימה של דני', [
      task('לשלוח הצעה לדני'),
      task('לבדוק קמפיין של דני'),
      task('לקבוע פגישה עם דני'),
    ]);
    expect(result.best).toBeNull();
    expect(result.isAmbiguous).toBe(true);
    expect(result.candidates).toHaveLength(3);
  });

  it('matches through a Hebrew prefix letter', () => {
    expect(matchTask('דני', [task('להתקשר לדני')]).best?.title).toBe('להתקשר לדני');
  });

  it('returns nothing when there is no plausible match', () => {
    const result = matchTask('הדוח הרבעוני', [task('להתקשר לדני')]);
    expect(result.best).toBeNull();
    expect(result.isAmbiguous).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it('prefers an exact title substring over token overlap', () => {
    const result = matchTask('לשלוח הצעה', [
      task('לשלוח הצעה לאביב'),
      task('לשלוח קובץ ולבדוק הצעה אחרת'),
    ]);
    expect(result.best?.title).toBe('לשלוח הצעה לאביב');
  });
});

describe('WhatsApp interactive limits', () => {
  it('truncates button titles to the API maximum', () => {
    const title = truncateButtonTitle('כותרת ארוכה מאוד שלא תתקבל על ידי ה-API');
    expect(title.length).toBeLessThanOrEqual(MAX_BUTTON_TITLE);
  });

  it('leaves short titles untouched', () => {
    expect(truncateButtonTitle('✅ בוצע')).toBe('✅ בוצע');
  });
});
