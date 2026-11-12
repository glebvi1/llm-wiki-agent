# Расшифровка для LLM Wiki

MCP `transcription` даёт Codex инструменты для расшифровки локальных аудио- и видеофайлов.

## Инструменты MCP

| Инструмент | Что делает |
| --- | --- |
| `transcribe_audio` | Расшифровывает аудио или видео. Требует абсолютный путь `file_path`. Поле `language` принимает двухбуквенный код языка (по умолчанию `ru`). С необязательным `output_path` сохраняет текст в новый файл `.txt` по абсолютному пути. Возвращает текст, длительность, выбранный сервис и признак переключения на запасной. |
| `transcription_status` | Показывает, настроен ли доступ к Groq и Deepgram, без вывода ключей. |

[Схемы параметров](server.mjs) и [логика выбора сервиса](core.mjs#L19).

## Выбор сервиса

- До 300 секунд включительно: Groq `whisper-large-v3`.
- При ошибке Groq, пустом ответе или ожидании больше 45 секунд: Deepgram `nova-3`.
- Дольше 300 секунд: сразу Deepgram, ожидание до 10 минут.

FFprobe определяет длительность, FFmpeg извлекает звук в моно FLAC 16 кГц.
Временный звук удаляется после запроса. Оригинал не меняется.
Расшифровка сама по себе не обновляет страницы вики.

## Доступ к сервисам

Секреты не входят в код и конфиг MCP. Они читаются при запросе:

- Groq: переменная `GROQ_API_KEY`, затем `groqKey` из `%APPDATA%/dictate/settings.json`.
  Если прямого ключа нет, используются `relayUrl` и `relayToken` того же Windows-приложения.
- Deepgram: `DEEPGRAM_API_KEY`, затем `deepgramKey` из настроек dictate,
  затем `DEEPGRAM_API_KEY` из файла, заданного переменной `TRANSCRIPTION_ENV_FILE`.

Большие записи идут напрямую в Deepgram, чтобы не зависеть от лимита шлюза в 32 МиБ.

## Проверка и обслуживание

Установите зависимости через `npm ci` в этой папке. Подключение `transcription` показано в [примере конфига Codex](../config.example.toml). Укажите путь к своему `server.mjs` и перезапустите Codex.

`node --test test.mjs` проверяет выбор сервиса и переключение при ошибке.

Настройка MCP: [официальная документация Codex](https://learn.chatgpt.com/docs/extend/mcp).
API: [Groq](https://console.groq.com/docs/speech-to-text),
[Deepgram](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded).
