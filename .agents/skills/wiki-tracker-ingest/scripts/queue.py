"""Verify delivered batches and checkpoint a single semantic-processing run."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid
from datetime import datetime, timezone


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(value):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value):
        raise ValueError("Курсор должен быть десятичной строкой")
    return int(value)


def local(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Путь выходит за пределы вики")
    return path


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def bundle_hash(skill):
    paths = [skill / "SKILL.md", skill / "agents/openai.yaml"]
    paths += sorted((skill / "references").glob("*.md"))
    paths += sorted((skill / "scripts").glob("*.py"))
    h = hashlib.sha256()
    for path in sorted(paths):
        h.update(path.relative_to(skill).as_posix().encode("utf-8") + b"\0")
        h.update(path.read_bytes() + b"\0")
    return h.hexdigest()


def inspect(root, skill):
    folder = root / ".local/tracker-wiki"
    state_path = folder / "state.json"
    state = read(state_path) if state_path.exists() else {
        "schemaVersion": 1, "processedCursor": "0", "processedHashes": {},
        "pendingQuestions": [], "dailyTasks": {}, "pendingOperations": [],
    }
    if state.get("schemaVersion") != 1:
        raise ValueError("Неизвестная версия состояния обработки")
    processed = number(state["processedCursor"])
    delivery = read(root / ".local/tracker-sync/status.json")
    received = number(delivery["cursor"])
    if processed > received:
        raise ValueError("Доставка отстаёт от сохранённой обработки: проверь восстановление состояния")
    for name, sha in state.get("processedHashes", {}).items():
        if digest(local(root, name)) != sha:
            raise ValueError("Изменён уже обработанный исходник: " + name)
    archives = []
    for path in (root / "Исходники/Трекер").glob("*/*.json"):
        if not re.fullmatch(r"[0-9]+-[0-9]+\.json", path.name):
            continue
        data = read(path)
        start, end = number(data["after"]), number(data["until"])
        if end <= processed or end > received:
            continue
        if start >= end or data.get("schemaVersion") != 1:
            raise ValueError("Неверные границы порции: " + str(path))
        pages = data["pages"]
        if not pages or pages[-1].get("complete") is not True:
            raise ValueError("Незавершённая порция: " + str(path))
        previous, changes = start, 0
        captured = pages[0]["capturedAt"]
        for index, page in enumerate(pages):
            if number(page["until"]) != end or page["capturedAt"] != captured:
                raise ValueError("Несогласованные страницы: " + str(path))
            if index < len(pages) - 1 and page.get("complete") is not False:
                raise ValueError("Ранняя отметка завершения порции")
            for change in page["changes"]:
                seq = number(change["sequence"])
                if not previous < seq <= end:
                    raise ValueError("Повтор или обратный порядок событий: " + str(path))
                previous = seq
                changes += 1
            if number(page["cursor"]) != previous:
                raise ValueError("Курсор страницы не совпадает с её событиями")
        if previous != end:
            raise ValueError("Порция не достигла объявленной границы")
        if start == 0 and "snapshot" not in pages[0]:
            raise ValueError("В первой порции отсутствует исходный снимок")
        archives.append({"path": path.relative_to(root).as_posix(), "sha256": digest(path),
                         "after": str(start), "until": str(end), "changes": changes})
    archives.sort(key=lambda item: number(item["after"]))
    cursor = processed
    for item in archives:
        if number(item["after"]) != cursor:
            raise ValueError("Разрыв или перекрытие порций после курсора " + str(cursor))
        cursor = number(item["until"])
    if cursor != received:
        raise ValueError("Не найдены все порции до границы доставки")
    for question in state.get("pendingQuestions", []):
        if not local(root, question["path"]).is_file():
            raise ValueError("Потеряны материалы вопроса " + question["id"])
    sha = bundle_hash(skill)
    approval = read(skill / "approval.json")
    active = folder / "active-run.json"
    return {"enabled": approval.get("status") == "approved" and approval.get("approvedBundleSha256") == sha,
            "bundleSha256": sha, "processedCursor": str(processed), "receivedCursor": str(received),
            "completeThrough": delivery.get("completeThrough"), "batches": archives,
            "pendingQuestions": state.get("pendingQuestions", []),
            "pendingOperations": state.get("pendingOperations", []),
            "activeRun": read(active) if active.exists() else None}, state


def begin(root, skill, maximum):
    status, _ = inspect(root, skill)
    if not status["enabled"]:
        raise ValueError("Эта версия скилла ещё не принята Глебом")
    if status["activeRun"]:
        raise ValueError("Продолжи незавершённый проход " + status["activeRun"]["runId"])
    batches = status["batches"][:maximum]
    run = {"schemaVersion": 1, "runId": uuid.uuid4().hex,
           "startedAt": datetime.now(timezone.utc).isoformat(), "bundleSha256": status["bundleSha256"],
           "from": status["processedCursor"],
           "through": batches[-1]["until"] if batches else status["processedCursor"], "batches": batches}
    folder = root / ".local/tracker-wiki"
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "active-run.json").open("x", encoding="utf-8") as file:
        json.dump(run, file, ensure_ascii=False, indent=2)
    atomic(folder / "runs" / run["runId"] / "input.json", run)
    return run


def finish(root, skill, result_path):
    folder = root / ".local/tracker-wiki"
    result = read(result_path)
    state_path = folder / "state.json"
    previous_state = read(state_path) if state_path.exists() else {}
    if not (folder / "active-run.json").exists():
        if previous_state.get("lastRunId") == result["runId"]:
            saved = read(folder / "runs" / result["runId"] / "result.json")
            if result != saved:
                raise ValueError("При повторе finish передан другой итог")
            return {"completed": result["runId"], "processedCursor": previous_state["processedCursor"], "recovered": True}
        raise ValueError("Нет незавершённого прохода для этого итога")
    run = read(folder / "active-run.json")
    if result["runId"] != run["runId"]:
        raise ValueError("Итог относится к другому проходу")
    status, state = inspect(root, skill)
    if not status["enabled"] or status["bundleSha256"] != run["bundleSha256"]:
        raise ValueError("Версия скилла не совпадает с принятой версией прохода")
    if state.get("lastRunId") == run["runId"]:
        saved = read(folder / "runs" / run["runId"] / "result.json")
        if result != saved:
            raise ValueError("При повторе finish передан другой итог")
        (folder / "active-run.json").unlink()
        return {"completed": run["runId"], "processedCursor": state["processedCursor"], "recovered": True}
    if state["processedCursor"] != run["from"]:
        raise ValueError("Состояние обработки изменилось после начала прохода")
    outcomes = result["outcomes"]
    if len(outcomes) != len(run["batches"]):
        raise ValueError("Не все порции получили итог")
    for batch, outcome in zip(run["batches"], outcomes):
        if any(outcome.get(key) != batch[key] for key in ("path", "sha256")):
            raise ValueError("Список итогов не совпадает с исходниками прохода")
        if digest(local(root, batch["path"])) != batch["sha256"]:
            raise ValueError("Исходник изменён во время прохода")
        if outcome["result"] not in {"applied", "no_change", "waiting", "mixed"}:
            raise ValueError("Неизвестный итог порции")
        if not local(root, outcome["evidencePath"]).is_file():
            raise ValueError("Не сохранено основание итога")
    for item in result["files"]:
        if digest(local(root, item["path"])) != item["sha256"]:
            raise ValueError("Сохранённый файл не совпадает с итогом: " + item["path"])
    ids = set()
    for question in result["pendingQuestions"]:
        if question["id"] in ids or not local(root, question["path"]).is_file():
            raise ValueError("Дубликат вопроса или отсутствуют его материалы")
        ids.add(question["id"])
    resolved = set()
    for question in result.get("resolvedQuestions", []):
        if question["id"] in ids or question["id"] in resolved or not local(root, question["evidencePath"]).is_file():
            raise ValueError("Не сохранено однозначное решение вопроса")
        resolved.add(question["id"])
    if any(q["id"] not in ids | resolved for q in state.get("pendingQuestions", [])):
        raise ValueError("Прежний вопрос потерян без сохранённого решения")
    if not local(root, result["summaryPath"]).is_file():
        raise ValueError("Не сохранён итог прохода")
    atomic(folder / "runs" / run["runId"] / "result.json", result)
    state.update({"processedCursor": run["through"], "lastRunId": run["runId"],
                  "pendingQuestions": result["pendingQuestions"], "dailyTasks": result["dailyTasks"],
                  "pendingOperations": result["pendingOperations"]})
    state.setdefault("processedHashes", {}).update({b["path"]: b["sha256"] for b in run["batches"]})
    atomic(folder / "state.json", state)
    (folder / "active-run.json").unlink()
    return {"completed": run["runId"], "processedCursor": state["processedCursor"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "begin", "finish"])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--max-batches", type=int, default=1)
    parser.add_argument("--result", type=Path)
    args = parser.parse_args()
    if args.max_batches < 1:
        raise ValueError("Нужно выбрать хотя бы одну порцию")
    root = args.root.resolve()
    skill = root / ".agents/skills/wiki-tracker-ingest"
    if args.command == "status":
        value = inspect(root, skill)[0]
    elif args.command == "begin":
        value = begin(root, skill, args.max_batches)
    else:
        if args.result is None:
            raise ValueError("Нужен --result")
        value = finish(root, skill, args.result.resolve())
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
