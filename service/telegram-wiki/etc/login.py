import asyncio
import getpass
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import qrcode
import qrcode.image.svg
from telethon import errors
from telethon.sync import TelegramClient
from telegram_mcp.client_identity import client_identity_kwargs
from telegram_mcp.singleton import SessionLock, session_identity


async def main():
    client, lock = telegram_client()
    lock.acquire(grace_seconds=1)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            qr = await client.qr_login()
            for _ in range(10):
                render(qr.url)
                try:
                    remaining = qr.expires.timestamp() - datetime.now(timezone.utc).timestamp()
                    await qr.wait(timeout=max(1, remaining - 1))
                    break
                except asyncio.TimeoutError:
                    await qr.recreate()
                except errors.SessionPasswordNeededError:
                    password = getpass.getpass("Двухфакторная аутентификация. Пароль: ")
                    await client.sign_in(password=password)
                    break
            else:
                raise RuntimeError("QR-код истёк")
        if not await client.is_user_authorized():
            raise RuntimeError("авторизация не подтверждена")
        print("Telegram авторизован. Сессия сохранена вне Wiki; секрет не выводится.")
    finally:
        await client.disconnect()
        lock.release()


async def web_main():
    client, lock = telegram_client()
    lock.acquire(grace_seconds=20)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            qr = await client.qr_login()
            for _ in range(10):
                emit("qr", svg=svg(qr.url))
                try:
                    remaining = qr.expires.timestamp() - datetime.now(timezone.utc).timestamp()
                    await qr.wait(timeout=max(1, remaining - 1))
                    break
                except asyncio.TimeoutError:
                    await qr.recreate()
                except errors.SessionPasswordNeededError:
                    await web_password(client)
                    break
            else:
                raise RuntimeError("QR-код истёк")
        if not await client.is_user_authorized():
            raise RuntimeError("авторизация не подтверждена")
        emit("connected")
    finally:
        await client.disconnect()
        lock.release()


def telegram_client():
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    session = os.environ["TELEGRAM_SESSION_NAME"]
    Path(session).parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(session, api_id, api_hash, **client_identity_kwargs())
    return client, SessionLock("default", session_identity(client))


async def web_password(client):
    detail = None
    while True:
        emit("password_required", **({"detail": detail} if detail else {}))
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            raise RuntimeError("канал ввода пароля закрыт")
        command = json.loads(line)
        if command.get("type") != "password":
            continue
        try:
            await client.sign_in(password=command["value"])
            return
        except errors.PasswordHashInvalidError:
            detail = "Пароль не принят. Проверьте его и попробуйте ещё раз."


def emit(event_type, **fields):
    print(json.dumps({"type": event_type, **fields}, ensure_ascii=False), flush=True)


def svg(url):
    code = qrcode.QRCode(border=2)
    code.add_data(url)
    code.make(fit=True)
    image = code.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    text = image.to_string().decode("ascii")
    return text[text.index("<svg") :]


def render(url):
    image = qrcode.QRCode(border=1)
    image.add_data(url)
    image.make(fit=True)
    output = io.StringIO()
    image.print_ascii(out=output, invert=True)
    print("\nTelegram → Настройки → Устройства → Подключить устройство:")
    print(output.getvalue())


if __name__ == "__main__":
    try:
        asyncio.run(web_main() if "--web" in sys.argv else main())
    except Exception as error:
        if "--web" in sys.argv:
            emit(
                "error",
                detail=f"Вход не завершён ({type(error).__name__}). Закройте другое приложение с этой сессией и попробуйте ещё раз.",
            )
        else:
            print(f"Вход не завершён: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
