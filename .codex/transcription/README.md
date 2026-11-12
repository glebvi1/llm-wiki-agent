# Расшифровка для LLM Wiki

MCP `transcription` подключён в конфигурации Codex.
После перезапуска Codex агент может вызывать `transcribe_audio` для локального аудио или видео.
Передай абсолютный путь `file_path`; язык `language` по умолчанию `ru`.
Необязательный `output_path` сохраняет текст в новый `.txt`, не заменяя существующие файлы.
Ответ содержит текст, длительность, сервис и признак переключения на запасной сервис.

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
`transcription_status` проверяет наличие доступа, не раскрывая секреты.

## Проверка и обслуживание

Node.js и зависимости уже установлены. Зависимости закреплены в `package-lock.json`.
После переноса проекта восстановить зависимости через `npm ci` в этой папке.
При переносе Node.js обновить его путь в `.codex/config.toml`.

`node --test test.mjs` проверяет выбор сервиса и переключение при ошибке.

Настройка MCP: [официальная документация Codex](https://learn.chatgpt.com/docs/extend/mcp).
API: [Groq](https://console.groq.com/docs/speech-to-text),
[Deepgram](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded).
