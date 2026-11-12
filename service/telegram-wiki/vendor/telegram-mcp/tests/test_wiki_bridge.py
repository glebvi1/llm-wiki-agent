"""Интеграционный адаптер Wiki: стабильные чтения и идемпотентная отправка."""

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from telethon.tl import functions, types

from telegram_mcp.tools import messages

DATE = datetime(2026, 11, 11, tzinfo=timezone.utc)
CHANNEL_ID = 1234567890
MARKED_CHANNEL_ID = -1001234567890


@pytest.fixture
def client(monkeypatch):
    cl = AsyncMock()
    entity = types.Channel(
        id=CHANNEL_ID, title="Wiki test", photo=types.ChatPhotoEmpty(), date=DATE
    )
    monkeypatch.setattr(messages, "get_client", lambda account=None: cl)
    monkeypatch.setattr(messages, "resolve_entity", AsyncMock(return_value=entity))
    monkeypatch.setattr(messages, "ensure_connected", AsyncMock())
    monkeypatch.setattr(messages, "is_chat_allowlist_enabled", lambda: False)
    monkeypatch.setattr(messages, "is_chat_blocklist_enabled", lambda: False)
    return cl


def _message(message_id=1):
    msg = types.Message(
        id=message_id,
        peer_id=types.PeerChannel(CHANNEL_ID),
        date=DATE,
        message="Решение из Telegram",
    )
    msg._chat = SimpleNamespace(id=CHANNEL_ID, title="Wiki test")
    return msg


@pytest.mark.asyncio
async def test_get_messages_before_uses_stable_max_id(client):
    client.get_messages.return_value = [_message()]

    result = json.loads(
        await messages.get_messages_before(MARKED_CHANNEL_ID, before_id=99, limit=100)
    )

    assert result["results"][0]["id"] == 1
    assert client.get_messages.await_args.kwargs == {"limit": 100, "max_id": 99}


@pytest.mark.asyncio
async def test_get_messages_by_ids_reports_deleted_ids(client):
    client.get_messages.return_value = [_message(), None]

    result = json.loads(
        await messages.get_messages_by_ids(MARKED_CHANNEL_ID, message_ids=[1, 2, 1])
    )

    assert [row["id"] for row in result["results"]] == [1]
    assert result["missing_ids"] == [2]
    assert client.get_messages.await_args.kwargs == {"ids": [1, 2]}


@pytest.mark.asyncio
async def test_plain_send_uses_exact_random_id_and_returns_message_id(client):
    client.return_value = types.UpdateShortSentMessage(
        id=77, pts=1, pts_count=1, date=DATE
    )

    result = await messages.send_message(
        MARKED_CHANNEL_ID, "Согласованный текст", reply_to=5, random_id=123456789
    )

    assert result.endswith("message_id=77")
    request = client.await_args.args[0]
    assert isinstance(request, functions.messages.SendMessageRequest)
    assert request.random_id == 123456789
    assert request.message == "Согласованный текст"
    assert request.reply_to.reply_to_msg_id == 5
    assert not request.entities


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options",
    [
        {"parse_mode": "rich"},
        {"format_date": "11/11/2026"},
        {"custom_emojis": [{"emoji": "👍", "id": "1"}]},
        {"random_id": 0},
    ],
)
async def test_random_id_rejects_rich_or_invalid_send_without_request(client, options):
    arguments = {"random_id": 123, **options}
    result = await messages.send_message(MARKED_CHANNEL_ID, "Текст", **arguments)

    assert "random_id" in result
    assert client.await_args is None
