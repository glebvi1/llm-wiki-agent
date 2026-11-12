import {
  type JSX,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  chats,
  configureChat,
  deleteSources,
  deletionPreview,
  processingStatus,
  syncNow,
  updateChat,
  type ChatView,
  type DeletionPreview,
} from "#src/api.ts";

import styles from "./app.module.scss";
import { TelegramAuth } from "./telegram-auth.tsx";

type Filter = "all" | "private" | "group" | "channel";
type Section = "connected" | "available";
type DialogMode = "connect" | "comment" | "history";
type DraftSettings = {
  importFrom: "now" | "date" | "all";
  fromDate: string | null;
  comment: string;
};

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "private", label: "Личные" },
  { id: "group", label: "Группы" },
  { id: "channel", label: "Каналы" },
];

export function App(): JSX.Element {
  const [items, setItems] = useState<ChatView[]>([]);
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>("available");
  const [sectionFilters, setSectionFilters] = useState<Record<Section, Filter>>(
    {
      connected: "all",
      available: "all",
    },
  );
  const [editing, setEditing] = useState<{
    chat: ChatView;
    mode: DialogMode;
  } | null>(null);
  const listRevisionRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [processingEnabled, setProcessingEnabled] = useState<boolean | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{
    chat: ChatView;
    preview: DeletionPreview;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async (quiet = false) => {
    const revision = ++listRevisionRef.current;
    if (!quiet) {
      setLoading(true);
    }
    setError(null);
    try {
      const [itemsResult, processingResult] = await Promise.allSettled([
        chats(),
        processingStatus(),
      ]);
      if (processingResult.status === "fulfilled") {
        setProcessingEnabled(processingResult.value.enabled);
      }
      if (itemsResult.status === "rejected") {
        throw itemsResult.reason;
      }
      if (revision === listRevisionRef.current) {
        setItems(itemsResult.value);
        setLoaded(true);
      }
    } catch (reason) {
      if (revision === listRevisionRef.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось получить список чатов",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);
  const handleConnected = useCallback(() => {
    void reload(true);
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filter = sectionFilters[section];
  const needle = query.trim().toLocaleLowerCase("ru");
  const visible = items.filter(
    (chat) =>
      Boolean(chat.settings?.enabled) === (section === "connected") &&
      (filter === "all" || chat.type === filter) &&
      (!needle ||
        chat.title.toLocaleLowerCase("ru").includes(needle) ||
        chat.username?.toLowerCase().includes(needle.replace(/^@/, ""))),
  );

  function applySettings(id: string, settings: ChatView["settings"]): void {
    listRevisionRef.current += 1;
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, settings } : item)),
    );
  }

  async function disconnect(chat: ChatView): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      applySettings(chat.id, await updateChat(chat.id, { enabled: false }));
      setNotice(`Чат «${chat.title}» отключён`);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось отключить чат",
      );
    }
  }

  async function saveSettings(
    chat: ChatView,
    mode: DialogMode,
    draft: DraftSettings,
  ): Promise<void> {
    const settings =
      mode === "comment"
        ? await updateChat(chat.id, { comment: draft.comment })
        : await configureChat(chat.id, {
            enabled: true,
            importFrom: draft.importFrom,
            fromDate: draft.importFrom === "date" ? draft.fromDate : null,
            ...(mode === "connect" ? { comment: draft.comment } : {}),
          });
    applySettings(chat.id, settings);
    setEditing(null);
    if (mode === "comment") {
      setNotice("Комментарий сохранён");
    } else {
      void updateNow();
    }
  }

  async function updateNow(): Promise<void> {
    setSyncing(true);
    setNotice(null);
    setError(null);
    try {
      await syncNow();
      setNotice(
        processingEnabled === false ? "Импорт запущен" : "Обновление запущено",
      );
      window.setTimeout(() => void reload(true), 2500);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось запустить обновление",
      );
    } finally {
      setSyncing(false);
    }
  }

  async function preview(chat: ChatView): Promise<void> {
    setError(null);
    try {
      setDeleting({ chat, preview: await deletionPreview(chat.id) });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось оценить удаление",
      );
    }
  }

  const connected = items.filter((chat) => chat.settings?.enabled).length;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.header}>
          <h1>Telegram в LLM Wiki</h1>
          <div className={styles.headerActions}>
            <TelegramAuth chatsLoaded={loaded} onConnected={handleConnected} />
            <button
              className={styles.primary}
              disabled={syncing || connected === 0}
              type="button"
              onClick={() => void updateNow()}
            >
              {syncing ? "Запускаем…" : "Обновить сейчас"}
            </button>
          </div>
        </header>
        {processingEnabled === false ? (
          <p className={styles.pending}>
            Для обновления страниц Wiki прими правила обработки Telegram в
            Codex.
          </p>
        ) : null}
        <section className={styles.workspace} aria-label="Выбор чатов">
          <div
            className={styles.sections}
            aria-label="Разделы чатов"
            role="group"
          >
            <button
              aria-pressed={section === "connected"}
              type="button"
              onClick={() => {
                setSection("connected");
              }}
            >
              Подключённые <span>{connected}</span>
            </button>
            <button
              aria-pressed={section === "available"}
              type="button"
              onClick={() => {
                setSection("available");
              }}
            >
              Не подключённые <span>{items.length - connected}</span>
            </button>
          </div>
          <div className={styles.toolbar}>
            <label className={styles.search}>
              <span aria-hidden="true">⌕</span>
              <input
                aria-label="Поиск по названию или @username"
                placeholder="Название или @username"
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </label>
            <button
              className={styles.iconButton}
              aria-label="Обновить список чатов"
              title="Обновить список"
              type="button"
              onClick={() => void reload()}
            >
              ↻
            </button>
          </div>
          <div
            className={styles.filters}
            aria-label="Фильтр чатов"
            role="group"
          >
            {filters.map((item) => (
              <button
                key={item.id}
                className={filter === item.id ? styles.activeFilter : ""}
                aria-pressed={filter === item.id}
                type="button"
                onClick={() => {
                  setSectionFilters((current) => ({
                    ...current,
                    [section]: item.id,
                  }));
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {notice ? (
            <div className={styles.notice} role="status">
              <span>✓</span>
              {notice}
              <button
                aria-label="Закрыть уведомление"
                type="button"
                onClick={() => {
                  setNotice(null);
                }}
              >
                ×
              </button>
            </div>
          ) : null}
          {error ? (
            <div className={styles.error} role="alert">
              <div>
                <strong>Ошибка Telegram</strong>
                <p>{error}</p>
              </div>
              <button type="button" onClick={() => void reload()}>
                Повторить
              </button>
            </div>
          ) : null}

          {loading && !loaded ? (
            <Loading />
          ) : !loading && items.length === 0 && !error ? (
            <Empty />
          ) : (
            <div
              className={
                section === "connected" ? styles.compactActions : undefined
              }
            >
              <div className={styles.listHead}>
                <span>Чат</span>
                <span>Импорт / Wiki</span>
              </div>
              {visible.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  onDelete={() => void preview(chat)}
                  onDisconnect={() => disconnect(chat)}
                  onEdit={(mode) => {
                    setError(null);
                    setNotice(null);
                    setEditing({ chat, mode });
                  }}
                />
              ))}
              {visible.length === 0 ? (
                <p className={styles.noMatches}>
                  {needle || filter !== "all"
                    ? "Чаты по этому запросу не найдены"
                    : section === "connected"
                      ? "Подключённых чатов пока нет"
                      : "Все чаты подключены"}
                </p>
              ) : null}
            </div>
          )}
        </section>
      </main>
      {editing ? (
        <ChatSettingsDialog
          chat={editing.chat}
          mode={editing.mode}
          onCancel={() => {
            setEditing(null);
          }}
          onSave={(draft) => saveSettings(editing.chat, editing.mode, draft)}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          chat={deleting.chat}
          preview={deleting.preview}
          onCancel={() => {
            setDeleting(null);
          }}
          onDeleted={async () => {
            await deleteSources(deleting.chat.id);
            applySettings(deleting.chat.id, null);
            setDeleting(null);
            setNotice("Исходники удалены");
          }}
        />
      ) : null}
    </div>
  );
}

function ChatRow({
  chat,
  onEdit,
  onDisconnect,
  onDelete,
}: {
  chat: ChatView;
  onEdit: (mode: DialogMode) => void;
  onDisconnect: () => Promise<void>;
  onDelete: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const actionsId = useId();
  const actionsRef = useRef<HTMLDivElement>(null);
  const settings = chat.settings;
  const enabled = settings?.enabled ?? false;
  const completeThrough = settings?.completeThrough
    ? formatDate(settings.completeThrough)
    : "неизвестной даты";

  function chooseAction(action: () => void): void {
    actionsRef.current?.hidePopover();
    action();
  }

  function disconnect(): void {
    setBusy(true);
    void onDisconnect().finally(() => {
      setBusy(false);
    });
  }

  return (
    <article className={`${styles.row} ${enabled ? styles.connectedRow : ""}`}>
      <div className={styles.chatInfo}>
        <span
          className={`${styles.avatar} ${chat.type === "private" ? "" : styles[chat.type]}`}
          aria-hidden="true"
        >
          {chat.type === "private"
            ? chat.title.slice(0, 1).toUpperCase()
            : chat.type === "group"
              ? "◉"
              : "◁"}
        </span>
        <div>
          <div className={styles.chatTitle}>
            <strong className={styles.chatName} title={chat.title}>
              {chat.title}
            </strong>
            <span className={styles.type}>{typeName(chat.type)}</span>
          </div>
          <div className={styles.chatDetails}>
            {chat.username ? (
              <small className={styles.username}>@{chat.username}</small>
            ) : null}
            {enabled && settings?.comment ? (
              <small title={settings.comment}>{settings.comment}</small>
            ) : null}
          </div>
        </div>
      </div>
      {settings ? (
        <div className={styles.statuses}>
          <Status
            detail={
              settings.lastError
                ? `${settings.lastError}. Данные доступны до ${completeThrough}.`
                : undefined
            }
            label="Импорт"
            value={
              settings.lastError
                ? "Ошибка"
                : enabled && !settings.backfillComplete
                  ? "Загружается история"
                  : settings.lastReceiveAt
                    ? formatDate(settings.lastReceiveAt)
                    : enabled
                      ? "Ожидает запуска"
                      : "Не настроено"
            }
            warning={Boolean(settings.lastError)}
          />
          <Status
            label="Wiki"
            value={
              settings.lastProcessAt
                ? formatDate(settings.lastProcessAt)
                : "Ещё не обработано"
            }
          />
        </div>
      ) : null}
      <div className={styles.rowActions}>
        {settings ? (
          <>
            <button
              className={styles.actionsButton}
              aria-label={`Действия для чата «${chat.title}»`}
              disabled={busy}
              popoverTarget={actionsId}
              title="Действия"
              type="button"
            />
            <div
              ref={actionsRef}
              className={styles.actionsMenu}
              id={actionsId}
              aria-label={`Действия для чата «${chat.title}»`}
              popover="auto"
              role="group"
            >
              {enabled ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      chooseAction(disconnect);
                    }}
                  >
                    Отключить
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      chooseAction(() => {
                        onEdit("comment");
                      });
                    }}
                  >
                    Изменить комментарий
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      chooseAction(() => {
                        onEdit("history");
                      });
                    }}
                  >
                    Настроить импорт
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    chooseAction(() => {
                      onEdit("connect");
                    });
                  }}
                >
                  Подключить
                </button>
              )}
              <hr className={styles.menuDivider} />
              <button
                className={styles.dangerLink}
                type="button"
                onClick={() => {
                  chooseAction(onDelete);
                }}
              >
                Удалить исходники…
              </button>
            </div>
          </>
        ) : (
          <button
            className={styles.primary}
            type="button"
            onClick={() => {
              onEdit("connect");
            }}
          >
            Подключить
          </button>
        )}
      </div>
    </article>
  );
}

const dialogTitles = {
  connect: "Подключить чат",
  comment: "Изменить комментарий",
  history: "Настроить импорт",
};
const commentExamples = {
  private: "Паша, одногруппник. Общаемся про учёбу и Научку",
  group:
    "Группа по численным методам. Брать задания, сроки и требования к сдаче",
  channel: "Канал про ML. Сохранять полезные материалы по моим проектам",
};

function ChatSettingsDialog({
  chat,
  mode,
  onCancel,
  onSave,
}: {
  chat: ChatView;
  mode: DialogMode;
  onCancel: () => void;
  onSave: (draft: DraftSettings) => Promise<void>;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => draftOf(chat));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialogRef.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="chat-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
          onCancel();
        }
      }}
    >
      <h2 id="chat-settings-title">{dialogTitles[mode]}</h2>
      <div className={styles.chatTitle}>
        <strong>{chat.title}</strong>
        <span className={styles.type}>{typeName(chat.type)}</span>
      </div>
      <form
        className={styles.dialogForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) {
            return;
          }
          setBusy(true);
          setError(null);
          void onSave(draft)
            .catch((reason: unknown) => {
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Не удалось сохранить настройки",
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {mode !== "history" ? (
          <label>
            Что это за чат?
            <textarea
              aria-describedby="chat-comment-hint"
              disabled={busy}
              maxLength={4000}
              placeholder={commentExamples[chat.type]}
              rows={4}
              value={draft.comment}
              onChange={(event) => {
                setDraft({ ...draft, comment: event.target.value });
              }}
            />
            <small id="chat-comment-hint">
              Кто здесь общается и что отсюда брать в вики
            </small>
          </label>
        ) : null}
        {mode !== "comment" ? (
          <label>
            Начать импорт
            <select
              disabled={busy}
              value={draft.importFrom}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  importFrom: event.target.value as DraftSettings["importFrom"],
                });
              }}
            >
              <option value="now">С текущего момента</option>
              <option value="date">С выбранной даты</option>
              <option value="all">Вся доступная история</option>
            </select>
          </label>
        ) : null}
        {mode !== "comment" && draft.importFrom === "date" ? (
          <label>
            Дата начала
            <input
              disabled={busy}
              required
              type="date"
              value={draft.fromDate ?? ""}
              onChange={(event) => {
                setDraft({ ...draft, fromDate: event.target.value });
              }}
            />
          </label>
        ) : null}
        {error ? (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.dialogActions}>
          <button disabled={busy} type="button" onClick={onCancel}>
            Отмена
          </button>
          <button className={styles.confirm} disabled={busy} type="submit">
            {mode === "connect" ? "Подключить" : "Сохранить"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Status({
  label,
  value,
  warning = false,
  detail,
}: {
  label: string;
  value: string;
  warning?: boolean;
  detail?: string | undefined;
}): JSX.Element {
  return (
    <div className={styles.status} title={detail}>
      <span className={warning ? styles.warningDot : styles.statusDot} />
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function DeleteDialog({
  chat,
  preview,
  onCancel,
  onDeleted,
}: {
  chat: ChatView;
  preview: DeletionPreview;
  onCancel: () => void;
  onDeleted: () => Promise<void>;
}): JSX.Element {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={styles.backdrop} role="presentation">
      <section
        className={styles.dialog}
        aria-labelledby="delete-title"
        aria-modal="true"
        role="dialog"
      >
        <h2 id="delete-title">Удалить исходники «{chat.title}»?</h2>
        <p>
          Удалятся исходники ({preview.sources.length}) и настройки импорта
          этого чата.
        </p>
        {preview.derivedPages.length > 0 ? (
          <div className={styles.affected}>
            <strong>
              Проверьте связанные страницы (
              {String(preview.derivedPages.length)}):
            </strong>
            {preview.derivedPages.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        ) : null}
        <label>
          Введите УДАЛИТЬ для подтверждения
          <input
            autoFocus
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
          />
        </label>
        {error ? <p className={styles.errorText}>{error}</p> : null}
        <div className={styles.dialogActions}>
          <button type="button" onClick={onCancel}>
            Отмена
          </button>
          <button
            className={styles.danger}
            disabled={confirmation !== "УДАЛИТЬ" || busy}
            type="button"
            onClick={() => {
              setBusy(true);
              void onDeleted()
                .catch((reason: unknown) => {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Не удалось удалить",
                  );
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            Удалить исходники
          </button>
        </div>
      </section>
    </div>
  );
}

function draftOf(chat: ChatView): DraftSettings {
  return {
    importFrom: chat.settings?.importFrom ?? "now",
    fromDate: chat.settings?.fromDate ?? null,
    comment: chat.settings?.comment ?? "",
  };
}

function typeName(type: ChatView["type"]): string {
  return type === "private" ? "Личный" : type === "group" ? "Группа" : "Канал";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function Loading(): JSX.Element {
  return (
    <p className={styles.empty} role="status">
      Загружаем чаты…
    </p>
  );
}

function Empty(): JSX.Element {
  return <p className={styles.empty}>Чатов пока нет</p>;
}
