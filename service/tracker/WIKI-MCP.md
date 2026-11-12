# MCP трекера задач

Агент через MCP читает и меняет задачи, проекты и другие данные трекера. Сервер MCP принимает запросы по Streamable HTTP на `/api/mcp` и передаёт их существующим обработчикам API трекера. Изменения сохраняются в PostgreSQL.

## Инструменты

| Что нужно | Инструменты |
| --- | --- |
| Получить текущее состояние | `get_snapshot` |
| Найти, открыть или изменить задачи | `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task` |
| Работать с проектами | `list_projects`, `get_project`, `create_project`, `update_project`, `delete_project` |
| Работать с целями | `list_goals`, `get_goal`, `create_goal`, `update_goal`, `delete_goal` |
| Работать со спринтами | `list_sprints`, `get_sprint`, `create_sprint`, `update_sprint`, `delete_sprint` |
| Работать с правилами повторения | `list_recurrences`, `get_recurrence`, `create_recurrence`, `update_recurrence`, `delete_recurrence` |
| Читать и менять комментарии задач | `list_logs`, `get_log`, `create_log`, `update_log`, `delete_log` |
| Читать и менять дневник | `list_journal`, `get_journal_entry`, `create_journal_entry`, `update_journal_entry`, `delete_journal_entry` |
| Прочитать или подтвердить недельный план | `get_week_plan`, `confirm_week_plan` |
| Управлять рутинами и отмечать выполнение | `list_routines`, `get_routine`, `create_routine`, `update_routine`, `list_routine_checks`, `get_routine_check`, `set_routine_check` |
| Работать с материалами проекта | `get_project_context`, `upload_project_file`, `attach_project_sheet`, `set_project_context_enabled`, `delete_project_context` |
| Работать с материалами и заметкой владельца | `get_owner_context`, `upload_owner_file`, `set_owner_context_enabled`, `delete_owner_context`, `set_owner_note` |
| Получить версию материалов или выгрузить историю | `get_context_revision`, `export_history` |

В списках можно искать по тексту и читать результаты порциями. Если сервер вернул `nextOffset`, это начало следующей порции.

## Как меняется задача

1. `list_tasks` помогает найти задачу, а `get_task` по её `id` возвращает текущее состояние и `version`.
2. В `update_task` агент передаёт `id`, прочитанную `version`, уникальный `operationId` и поля, которые нужно изменить. Через этот же инструмент можно перенести задачу, сменить проект или отметить её выполненной.
3. Если ответ потерялся, агент повторяет те же параметры с тем же `operationId`. Сервер возвращает сохранённый результат команды. Если за это время версия задачи изменилась, новую правку нужно пересмотреть по свежим данным.

## Подключение и код

Для подключения нужны адрес развёрнутого трекера и токен доступа. В [примере конфига Codex](../../.codex/config.example.toml) подключение называется `tracker`. Полное приложение трекера работает отдельно.

В коде можно посмотреть [схемы параметров](src/server/mcp/catalog.ts), [передачу вызова в API](src/server/mcp/server.ts#L103), [проверку версии и повтора на стороне API](src/server/api/wiki.ts#L44) и [доставку истории в Wiki](etc/wiki-sync.ts).
