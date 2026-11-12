import {
  type SyntheticEvent,
  type JSX,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  cancelTelegramLogin,
  loginTelegram,
  submitTelegramPassword,
  telegramStatus,
  type TelegramConnection,
} from "#src/api.ts";

import styles from "./telegram-auth.module.scss";

export function TelegramAuth({
  chatsLoaded,
  onConnected,
}: {
  chatsLoaded: boolean;
  onConnected: () => void;
}): JSX.Element {
  const [connection, setConnection] = useState<TelegramConnection | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const notifiedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setConnection(await telegramStatus());
    } catch (reason) {
      setError(message(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [chatsLoaded, refresh]);

  const active = ["starting", "qr", "password", "checking"].includes(
    connection?.status ?? "idle",
  );
  useEffect(() => {
    if (!open || !active) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 800);
    return () => {
      window.clearInterval(timer);
    };
  }, [active, open, refresh]);

  useEffect(() => {
    if (open && connection?.status === "connected" && !notifiedRef.current) {
      notifiedRef.current = true;
      onConnected();
    }
  }, [connection?.status, onConnected, open]);

  async function start(): Promise<void> {
    setOpen(true);
    setBusy(true);
    setError(null);
    setPassword("");
    notifiedRef.current = false;
    try {
      setConnection(await loginTelegram());
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function close(): Promise<void> {
    if (active) {
      setBusy(true);
      try {
        setConnection(await cancelTelegramLogin());
      } catch (reason) {
        setError(message(reason));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setOpen(false);
    setError(null);
    setPassword("");
  }

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setConnection(await submitTelegramPassword(password));
      setPassword("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  const connected = connection?.status === "connected";
  return (
    <>
      <button
        className={`${styles.authButton} ${connected ? styles.connected : ""}`}
        type="button"
        onClick={() => {
          if (connected) {
            setOpen(true);
          } else {
            void start();
          }
        }}
      >
        <span aria-hidden="true" />
        {connected ? "Telegram подключён" : "Авторизоваться"}
      </button>
      {open ? (
        <div className={styles.backdrop} role="presentation">
          <section
            className={styles.dialog}
            aria-labelledby="telegram-auth-title"
            aria-modal="true"
            role="dialog"
          >
            <h2 id="telegram-auth-title">
              {connected ? "Telegram подключён" : "Вход в Telegram"}
            </h2>
            {!connected ? (
              <>
                <p className={styles.lead}>
                  {connection?.detail ?? "Готовим QR-код…"}
                </p>
                {connection?.status === "qr" && connection.qrSvg ? (
                  <div className={styles.qrFrame}>
                    <img
                      alt="QR для подключения устройства в Telegram"
                      src={`data:image/svg+xml;utf8,${encodeURIComponent(connection.qrSvg)}`}
                    />
                  </div>
                ) : null}
                {connection?.status === "starting" ||
                connection?.status === "checking" ? (
                  <div className={styles.waiting} role="status">
                    <span className={styles.loader} />
                    Подключаемся к Telegram…
                  </div>
                ) : null}
                {connection?.status === "password" ? (
                  <form
                    className={styles.password}
                    onSubmit={(event) => void submit(event)}
                  >
                    <label>
                      Пароль двухфакторной аутентификации
                      <input
                        autoComplete="off"
                        autoFocus
                        disabled={busy}
                        type="password"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                        }}
                      />
                    </label>
                    <button
                      className={styles.primary}
                      disabled={busy || !password}
                      type="submit"
                    >
                      Подтвердить вход
                    </button>
                  </form>
                ) : null}
              </>
            ) : null}
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button
                disabled={busy}
                type="button"
                onClick={() => void close()}
              >
                {active ? "Отменить вход" : "Закрыть"}
              </button>
              {connected ? (
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void start()}
                >
                  Переподключить аккаунт
                </button>
              ) : null}
              {!connected && !active ? (
                <button
                  className={styles.primary}
                  disabled={busy}
                  type="button"
                  onClick={() => void start()}
                >
                  Показать QR
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Не удалось выполнить вход";
}
