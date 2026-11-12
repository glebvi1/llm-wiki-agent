import { readFile, stat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import probe from 'ffprobe-static';
const run = promisify(execFile);

export async function keys() {
  const settings = process.env.APPDATA
    ? JSON.parse(await readFile(path.join(process.env.APPDATA, 'dictate/settings.json'), 'utf8').catch(() => '{}'))
    : {};
  const envFile = process.env.TRANSCRIPTION_ENV_FILE;
  const env = envFile ? parseEnv(await readFile(envFile, 'utf8').catch(() => '')) : {};
  return { groq: process.env.GROQ_API_KEY || settings.groqKey || '', deepgram: process.env.DEEPGRAM_API_KEY || settings.deepgramKey || env.DEEPGRAM_API_KEY || '', relayUrl: settings.relayUrl || '', relayToken: settings.relayToken || '' };
}

export async function route(seconds, providers) {
  if (seconds > 300) return { ...await providers.deepgram(), provider: 'deepgram', fallback: false };
  try { return { ...await providers.groq(), provider: 'groq', fallback: false }; }
  catch (error) {
    return { ...await providers.deepgram(), provider: 'deepgram', fallback: true, groq_error: error.message };
  }
}

export async function transcribe({file_path, language = 'ru', output_path}) {
  if (!path.isAbsolute(file_path)) throw new Error('Нужен абсолютный путь к файлу.');
  const info = await stat(file_path);
  if (!info.isFile() || !info.size) throw new Error('Нужен непустой аудио- или видеофайл.');
  const { stdout } = await run(probe.path, ['-v','error','-show_entries','format=duration','-of','json',file_path], {timeout:30000, windowsHide:true});
  const seconds = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Не удалось определить длительность записи.');
  const secret = await keys();
  const dir = await mkdtemp(path.join(tmpdir(), 'wiki-transcription-'));
  try {
    const audio = path.join(dir, 'audio.flac');
    await run(ffmpeg, ['-nostdin','-v','error','-i',file_path,'-vn','-ac','1','-ar','16000',audio], {timeout:600000,windowsHide:true});
    const bytes = await readFile(audio);
    async function request(provider) {
      const relay = provider === 'groq' && !secret.groq && secret.relayUrl && secret.relayToken;
      if (!secret[provider] && !relay) throw new Error(`${provider}: ключ не найден.`);
      let url, body, headers;
      if (provider === 'groq') {
        if (bytes.length > 24 * 1024 * 1024) throw new Error('Groq: файл больше 24 МБ.');
        url = 'https://api.groq.com/openai/v1/audio/transcriptions';
        body = new FormData();
        body.set('file', new Blob([bytes], {type:'audio/flac'}), 'audio.flac');
        body.set('model','whisper-large-v3'); body.set('language',language);
        body.set('response_format','json'); body.set('temperature','0');
        headers = {Authorization:`Bearer ${secret.groq}`};
        if (relay) {
          const base = new URL(secret.relayUrl);
          if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Некорректный адрес шлюза распознавания.');
          url = `${secret.relayUrl.replace(/\/+$/, '')}/groq/openai/v1/audio/transcriptions`;
          headers.Authorization = `Bearer ${secret.relayToken}`;
        }
      } else {
        url = `https://api.deepgram.com/v1/listen?model=nova-3&language=${encodeURIComponent(language)}&smart_format=true&paragraphs=true`;
        body = bytes; headers = {Authorization:`Token ${secret.deepgram}`, 'Content-Type':'audio/flac'};
      }
      let res;
      try { res = await fetch(url, {method:'POST',headers,body,signal:AbortSignal.timeout(provider === 'groq' ? 45000 : 600000)}); }
      catch { throw new Error(`${provider}: сеть или превышено время ожидания.`); }
      if (!res.ok) throw new Error(`${provider}: HTTP ${res.status}`);
      const data = await res.json();
      const alt = data.results?.channels?.[0]?.alternatives?.[0];
      const text = (provider === 'groq' ? data.text : alt?.paragraphs?.transcript ?? alt?.transcript)?.trim();
      if (!text) throw new Error(`${provider}: пустая расшифровка.`);
      return {text};
    }
    const result = {...await route(seconds, {groq:()=>request('groq'),deepgram:()=>request('deepgram')}),duration_seconds:seconds,source_path:file_path};
    if (output_path) {
      if (!path.isAbsolute(output_path) || path.extname(output_path).toLowerCase() !== '.txt') throw new Error('Для сохранения нужен абсолютный путь к новому .txt файлу.');
      await writeFile(output_path, result.text, {encoding:'utf8',flag:'wx'});
      result.output_path = output_path;
    }
    return result;
  } finally { await rm(dir, {recursive:true,force:true}); }
}
