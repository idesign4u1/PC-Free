import { IntegrationError } from '../utils/errors.js';

export interface TranscriptionResult {
  text: string;
  language: string | null;
  latencyMs: number;
  provider: string;
  model: string;
}

export interface SttProvider {
  readonly name: string;
  readonly model: string;
  transcribe(
    audio: Buffer,
    mimeType: string,
    opts?: { language?: string; prompt?: string },
  ): Promise<TranscriptionResult>;
}

/**
 * OpenAI audio transcription. WhatsApp voice notes arrive as OGG/Opus, which
 * the endpoint accepts directly — no local transcoding needed.
 */
export class OpenAiSttProvider implements SttProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly defaultLanguage: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly timeoutMs = 60_000,
  ) {}

  async transcribe(
    audio: Buffer,
    mimeType: string,
    opts: { language?: string; prompt?: string } = {},
  ): Promise<TranscriptionResult> {
    const started = Date.now();
    const extension = mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('mp4') || mimeType.includes('m4a')
        ? 'm4a'
        : mimeType.includes('wav')
          ? 'wav'
          : 'mp3';

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: mimeType.split(';')[0] }),
      `voice.${extension}`,
    );
    form.append('model', this.model);
    form.append('language', opts.language ?? this.defaultLanguage);
    form.append('response_format', 'json');
    // A domain hint measurably improves Hebrew/English code-switching.
    form.append(
      'prompt',
      opts.prompt ??
        'הודעה קולית בעברית לעוזר אישי לניהול משימות ויומן. ייתכנו מונחים באנגלית כמו Google Ads, campaign, meeting, deadline.',
    );

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new IntegrationError(
        'stt',
        `Transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        res.status,
      );
    }
    const data = (await res.json()) as { text?: string; language?: string };
    if (!data.text?.trim())
      throw new IntegrationError('stt', 'Transcription returned no text', 422, false);

    return {
      text: data.text.trim(),
      language: data.language ?? null,
      latencyMs: Date.now() - started,
      provider: this.name,
      model: this.model,
    };
  }
}
