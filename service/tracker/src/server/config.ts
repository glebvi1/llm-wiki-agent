/* eslint-disable n/no-process-env --
   единственная точка чтения окружения в сервере; остальной код берёт значения отсюда */
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function opt(name: string, def = ""): string {
  return (process.env[name] ?? def).trim();
}

/** Список значений через запятую. Пустые элементы отбрасываются. */
function list(name: string): readonly string[] {
  return opt(name)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Время `HH:MM` или умолчание. Проверяется здесь, а не в точке использования: недельное время
 * читают и планировщик, и граница среза отчёта, и у второго опечатка в окружении превратилась
 * бы в `Invalid Date` вместо сдвига ритма.
 */
function time(raw: string, def: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) {
    return def;
  }
  const [, hours, minutes] = match;
  if (Number(hours) > 23 || Number(minutes) > 59) {
    return def;
  }
  return `${hours.padStart(2, "0")}:${minutes}`;
}

/** Положительное число или умолчание. Мусор в окружении не должен доезжать до `setTimeout`. */
function positive(raw: string, def: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : def;
}

function flag(name: string, def: boolean): boolean {
  const raw = opt(name);
  if (raw === "") {
    return def;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Путь относительно корня пакета, а не текущей директории процесса: воркер, тесты и живые
 * проверки запускаются из разных мест, а данные раздела должны лежать в одном.
 */
function packagePath(raw: string): string {
  return path.resolve(PACKAGE_ROOT, raw);
}

function optionalPackagePath(raw: string): string {
  return raw === "" ? "" : packagePath(raw);
}

/** Команда с аргументами через пробел: `python -m yt_dlp` → `["python", "-m", "yt_dlp"]`. */
function command(raw: string, def: string): readonly string[] {
  const parts = raw.split(/\s+/).filter((part) => part !== "");
  return parts.length > 0 ? parts : [def];
}

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function llmProvider(raw = opt("LLM_PROVIDER")): "claude" | "codex" {
  switch (raw.trim().toLowerCase()) {
    case "":
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    default:
      throw new Error(`неизвестный LLM_PROVIDER: «${raw}»`);
  }
}

// Локальные дефолты входа. Вынесены в именованные константы, потому что по ним же `devDefaults`
// узнаёт, что настройку так и не тронули, — а в проде это значит «вход открыт всем».
const DEV_AUTH_SECRET = "dev-only-insecure-secret-change-me-please";
const DEV_APP_PASSWORD = "tracker";

export const config = {
  port: Number(opt("PORT", "3100")),

  // Абсолютная ссылка уходит в Telegram из фонового процесса, где нет HTTP-request origin.
  // Фрагмент с capability браузер серверу не отправляет, поэтому секрет не попадает в access log.
  publicBaseUrl: opt(
    "PUBLIC_BASE_URL",
    opt("NODE_ENV") === "production"
      ? "https://tracker.example.com"
      : "http://localhost:5174",
  ).replace(/\/$/, ""),

  // PostgreSQL — основное хранилище. Пустая строка = не сконфигурировано: пул создаётся,
  // но `initDb()` падает с понятной ошибкой до первого запроса.
  databaseUrl: opt("DATABASE_URL"),

  // Секрет подписи session-cookie (JWT). В проде обязателен; в dev есть слабый дефолт,
  // чтобы поднять локально без настройки. Длина ≥ 32 символов.
  authSecret: opt("AUTH_SECRET", DEV_AUTH_SECRET),

  // Система однопользовательская: вход в веб — один пароль, без учёток и регистрации.
  // Роль «кто это» в Телеграме играет `telegramChatId` — чужой чат просто игнорируется.
  appPassword: opt("APP_PASSWORD", DEV_APP_PASSWORD),
  wikiApiToken: opt("WIKI_API_TOKEN"),

  // Ключи остаются на сервере: короткие записи сначала идут в Groq, Deepgram — запасной.
  groqApiKey: opt("GROQ_API_KEY"),
  deepgramApiKey: opt("DEEPGRAM_API_KEY"),

  telegram: {
    apiRoot: opt("TELEGRAM_API_ROOT", "https://api.telegram.org").replace(
      /\/$/,
      "",
    ),
    botToken: opt("TELEGRAM_BOT_TOKEN"),
    // Группа, из которой принимаем команды и куда шлём отчёты. Отрицательный id.
    chatId: opt("TELEGRAM_CHAT_ID"),
    // Единственный человек, чьи команды бот выполняет. Строкой, а не числом: сравниваем с
    // `String(from.id)`, и лишнее преобразование числа из окружения только добавило бы способов
    // ошибиться — пустая строка даёт `Number("") === 0`, а это валидный id.
    //
    // Одного `chatId` мало: он пропуск в чат, а не в систему. В группу можно позвать кого угодно
    // — по умолчанию это может любой её участник, — и без этой проверки приглашённый получил бы
    // ровно те же права, что владелец: заводить задачи, читать отчёты и дневник, закрывать
    // напоминания.
    ownerId: opt("TELEGRAM_OWNER_ID"),
    // Кого тегать в напоминаниях (`@ник` или числовой id). Пусто — тегания нет.
    mention: opt("TELEGRAM_MENTION"),
  },

  llm: {
    // Переключатель один на оба сценария: разбор речи и менторские отчёты.
    // Неизвестное значение не должно случайно включать старый платный транспорт.
    provider: llmProvider(),
    // Имя выбранной модели показывается в каталоге промптов.
    model:
      llmProvider() === "codex"
        ? opt("CODEX_MODEL", "gpt-5.6-sol")
        : opt("ANTHROPIC_MODEL", "claude-opus-5"),

    claude: {
      // Один OAuth-токен Claude Code на прямой Messages API и `claude --print`.
      oauthToken: opt("ANTHROPIC_OAUTH_TOKEN"),
      model: opt("ANTHROPIC_MODEL", "claude-opus-5"),
      bin: opt("CLAUDE_BIN", "claude"),
    },

    codex: {
      // ChatGPT-авторизация живёт в `$CODEX_HOME/auth.json` и обновляется CLI на месте.
      home: opt(
        "CODEX_HOME",
        path.join(opt("HOME", opt("USERPROFILE", "/root")), ".codex"),
      ),
      model: opt("CODEX_MODEL", "gpt-5.6-sol"),
      // npm на Windows ставит CLI как `.cmd`; в Linux-образе это обычный executable.
      bin: opt(
        "CODEX_BIN",
        process.platform === "win32" ? "codex.cmd" : "codex",
      ),
    },

    // Куда агент раскладывает материалы прогона. По умолчанию — во временный каталог
    // системы, НЕ внутрь репозитория: агент определяет корень чтения по рабочей директории,
    // и внутри репозитория этим корнем стал бы весь монорепозиторий — вместе с `.env`
    // и прочим, что лежит рядом с кодом.
    agentWorkspace: opt(
      "AGENT_WORKSPACE",
      path.join(tmpdir(), "tracker-agent"),
    ),
    // Потолок одного прогона. Агент читает файлы и думает — это минуты, а не секунды;
    // но зависший процесс не должен держать отчёт до утра. Опечатка в окружении не должна
    // превращаться в `NaN`: `setTimeout(fn, NaN)` срабатывает немедленно, и каждый прогон
    // молча падал бы с «не уложился в NaN мс».
    agentTimeoutMs: positive(opt("AGENT_TIMEOUT_MS"), 300_000),
  },

  // Расписание — по Москве. Вынесено в окружение, чтобы сдвинуть ритм без правки кода.
  schedule: {
    morningAt: opt("MORNING_AT", "08:00"),
    nudgeAt: opt("NUDGE_AT", "21:00"),
    // В воскресенье это точная граница среза: тот же час задаёт и запуск анализа, и конец
    // недельного окна в `goal-report/generate.ts` — разъехавшись, они запретили бы сборку
    // до наступления старой границы. После пропуска следующий запуск догоняет закрытую
    // неделю сразу; снимок и outbox гасят повторы.
    weeklyAt: time(opt("WEEKLY_AT"), "12:00"),
    // Месячный отчёт — 1-го числа за прошедший месяц. Не последним днём: в 20:00 месяц ещё
    // не дожит, а «последний день» — это 28/29/30/31, лишняя арифметика на ровном месте.
    monthlyDay: Number(opt("MONTHLY_DAY", "1")),
    monthlyAt: opt("MONTHLY_AT", "20:00"),
    // Сколько задач на завтра считается «очевидно мало» — ниже порога прилетает пинок.
    nudgeThreshold: Number(opt("NUDGE_THRESHOLD", "2")),
    // Пинки по напоминаниям: утром вместе со списком дня, дальше — только если не ответил.
    remindMorningAt: opt("REMIND_MORNING_AT", "08:00"),
    remindDayAt: opt("REMIND_DAY_AT", "15:00"),
    remindEveningAt: opt("REMIND_EVENING_AT", "20:00"),
  },

  // Google: CRM и финансы. Ключ сервисного аккаунта лежит файлом в корне
  // репозитория (он в .gitignore). Пусто — синхронизация не запускается, остальное работает.
  google: {
    serviceAccountFile: opt(
      "GOOGLE_SERVICE_ACCOUNT_FILE",
      "../../tracker-503516-7fc7f3cba024.json",
    ),

    // CRM нетворкинга: одна таблица, один лист. Отсюда берутся дни рождения.
    crmSheetId: opt("GOOGLE_CRM_SHEET_ID"),
    // Имя листа без прямоугольника — Sheets отдаёт всю занятую область. Диапазон вида
    // `A1:Z2000` молча отрезал бы контакты ниже двухтысячной строки.
    crmSheetRange: opt("GOOGLE_CRM_SHEET_RANGE", "Лист1"),

    // Финансы разнесены по годам — таблиц несколько. Список идентификаторов через запятую,
    // порядок значения не имеет: год берётся из названия самой таблицы.
    financeSheetIds: list("GOOGLE_FINANCE_SHEET_IDS"),

    // Во сколько по Москве подтягивать таблицы.
    syncAt: opt("GOOGLE_SYNC_AT", "07:40"),
  },

  // Рубильники фоновых процессов: тесты и локальный фронтенд поднимают API без бота и
  // планировщика, иначе два запущенных процесса дерутся за один `getUpdates`.
  enableBot: flag("ENABLE_BOT", true),
  enableScheduler: flag("ENABLE_SCHEDULER", true),
  // Воркер обработки выпусков «Слушать». Живёт в процессе сервера и обрабатывает по одному
  // выпуску: второй процесс с тем же `LISTEN_DIR` взялся бы за те же файлы.
  enableListenWorker: flag("ENABLE_LISTEN_WORKER", true),

  // Раздел «Слушать»: звук из видео и подкастов. Без `yt-dlp` и `ffmpeg` выпуски честно
  // получают ошибку, а остальной трекер и уже готовые выпуски работают как обычно.
  listen: {
    // Аудио, обложки, недокачанные загрузки и рабочие каталоги обработки. Относительный путь
    // считается от корня пакета; умолчание лежит под `temp/`, который уже в `.gitignore`.
    dir: packagePath(opt("LISTEN_DIR", "temp/listen")),
    // Команда, а не путь: локально это обычно `python -m yt_dlp`. Аргументы через пробел,
    // поэтому путь с пробелами здесь не поддержан.
    ytdlp: command(opt("LISTEN_YTDLP"), "yt-dlp"),
    // Самообновление: в проде `LISTEN_YTDLP` указывает на копию в томе, а исходник для этой
    // копии лежит в образе. YouTube ломает `yt-dlp` чаще, чем выходит новый образ.
    ytdlpUpdate: flag("LISTEN_YTDLP_UPDATE", false),
    ytdlpImage: opt("LISTEN_YTDLP_IMAGE", "/usr/local/bin/yt-dlp"),
    ffmpeg: opt("LISTEN_FFMPEG", "ffmpeg"),
    ffprobe: opt("LISTEN_FFPROBE", "ffprobe"),
    // Прокси по источникам: российские площадки закрыты для зарубежных адресов, а YouTube
    // требует «подтвердить, что не робот» у адресов дата-центров. Общий — для всех прочих
    // и запасной для обоих частных.
    proxy: {
      any: opt("LISTEN_PROXY"),
      youtube: opt("LISTEN_PROXY_YOUTUBE"),
      ru: opt("LISTEN_PROXY_RU"),
    },
    // Файлы cookies.txt (формат Netscape). Относительный путь — от корня пакета.
    cookies: {
      youtube: optionalPackagePath(opt("LISTEN_COOKIES_YOUTUBE")),
      ru: optionalPackagePath(opt("LISTEN_COOKIES_RU")),
    },
    // Защита общего с соседними сервисами диска: меньше этого свободного места — новые
    // выпуски не принимаются.
    minFreeBytes: positive(opt("LISTEN_MIN_FREE_GB"), 5) * 1024 ** 3,
  },

  isProduction: opt("NODE_ENV") === "production",
} as const;

export type Config = typeof config;

/**
 * Настройки входа, оставшиеся на локальных дефолтах. Пароль «tracker» и секрет из примера
 * знает каждый, кто открывал репозиторий, поэтому в проде с ними подниматься нельзя — точка
 * входа падает, а не работает молча с открытой дверью.
 */
export function devDefaults(): string[] {
  const names: string[] = [];
  if (config.appPassword === DEV_APP_PASSWORD) {
    names.push("APP_PASSWORD");
  }
  if (config.authSecret === DEV_AUTH_SECRET) {
    names.push("AUTH_SECRET");
  }
  return names;
}

export const onlyForTesting = { llmProvider, time };
