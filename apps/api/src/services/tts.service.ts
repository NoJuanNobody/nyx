import OpenAI from 'openai';
import { config } from '../lib/config.js';

const VOICE_MAP: Record<string, 'alloy' | 'nova' | 'echo' | 'fable' | 'onyx' | 'shimmer'> = {
  'Host A': 'alloy',
  'Host B': 'nova',
};

class TtsService {
  private getClient(): OpenAI {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    return new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  async generateSegmentAudio(text: string, voice: 'alloy' | 'nova' | 'echo' | 'fable' | 'onyx' | 'shimmer'): Promise<Buffer> {
    const client = this.getClient();
    const response = await client.audio.speech.create({
      model: 'tts-1',
      voice,
      input: text,
      response_format: 'mp3',
    });

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async generatePodcastAudio(
    script: Array<{ speaker: string; text: string }>,
  ): Promise<Buffer> {
    const buffers: Buffer[] = [];

    for (const segment of script) {
      const voice = VOICE_MAP[segment.speaker] ?? 'alloy';
      const buffer = await this.generateSegmentAudio(segment.text, voice);
      buffers.push(buffer);
    }

    return Buffer.concat(buffers);
  }
}

export const ttsService = new TtsService();
