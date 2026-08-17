// Baked-in provider configuration.
// Providers are tried in order; within each provider, preferred models are tried in order.
// If a preferred model is not available, other capable models are discovered and tried.
// Override any value via environment variables (TEXT_PROVIDERS, TEXT_PREFERENCES, STT_PROVIDERS,
// STT_PREFERENCES, TTS_PROVIDERS, TTS_PREFERENCES, TTS_SPEED, STT_LANGUAGE).
// WARNING: do not commit this file with real secrets.

const env = (k, fallback) => process.env[k] || fallback;
const envJson = (k, fallback) => {
  const v = process.env[k];
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

export const CONFIG = {
  chat: {
    providers: envJson('TEXT_PROVIDERS', [
      {
        protocol: 'openai-compatible',
        baseUrl: 'https://celedog.io/v1',
        apiKey: 'sk-rCRVSuiZ64bC15AuJU9VZshP88V1rNSU6cArwmNwma5SFEPV',
      },
    ]),
    preferences: envJson('TEXT_PREFERENCES', [
      'celedog/auto-chat',
      'celedog/auto-chinese',
      'qwen3-max',
      'qwen3-plus',
      'qwen3.5-plus',
      'gpt-4o-mini',
      'gpt-4o',
    ]),
  },
  stt: {
    providers: envJson('STT_PROVIDERS', [
      {
        protocol: 'openai-compatible',
        baseUrl: 'https://celedog.io/v1',
        apiKey: 'sk-rCRVSuiZ64bC15AuJU9VZshP88V1rNSU6cArwmNwma5SFEPV',
      },
    ]),
    language: env('STT_LANGUAGE', 'en'),
    preferences: envJson('STT_PREFERENCES', [
      'qwen3-asr-flash-realtime',
      'qwen3-asr-flash',
      'whisper-1',
    ]),
  },
  tts: {
    providers: envJson('TTS_PROVIDERS', [
      {
        protocol: 'openai-compatible',
        baseUrl: 'https://celedog.io/v1',
        apiKey: 'sk-rCRVSuiZ64bC15AuJU9VZshP88V1rNSU6cArwmNwma5SFEPV',
      },
    ]),
    speed: env('TTS_SPEED', '1.15'),
    preferences: envJson('TTS_PREFERENCES', [
      // qwen3-tts-flash does not accept a voice parameter.
      { model: 'qwen3-tts-flash' },
      { model: 'qwen3-tts-flash-realtime' },
      { model: 'tts-1', voice: 'alloy' },
      { model: 'tts-1', voice: 'echo' },
    ]),
  },
};
