# Посещаемость — PWA для школы

Учителя отмечают отсутствующих и льготное питание, завуч выгружает Excel в формате образцов.

## Как пользоваться
- **Учитель:** вход по ФИО + общий код → переключатель в шапке **Посещаемость / Питание** → список классов (статусы зависят от режима) → класс. Посещаемость: по болезни / уважительная / без причины. Питание: Многодетные, ОВЗ, Детский дом, СВО и Платники — все по фамилиям. Избранные классы (звезда) на телефоне.
- **Завуч:** то же + сводка «отмечено классов», выгрузка Excel, добавление/редактирование/удаление классов. При создании/редактировании класса задаются **Всего учеников** и **Питающихся** (сколько обычно кушают — не то же, что численность класса).
- Фамилии подсказываются при вводе. Ученик может быть только в одном списке за день внутри раздела (повторное добавление переносит его).
- Excel: отмеченные классы — светло-зелёные строки; внизу строка **Итого**. В посещаемости дополнительно итоги блоков **1–4**, **5–9**, **10–11** (после соответствующих классов). Посещаемость: «По факту» = «Всего» − отсутствующие. Питание: «Всего» = питающиеся класса; «По факту» = «Всего» − льготные − платники.

## Запуск локально
Нужен **Node.js 22.5+** (встроенный `node:sqlite`, без native-модулей).

```bash
cp .env.example .env   # отредактируйте
npm install
set -a && source .env && set +a
npm start              # http://localhost:3000
```

## Обновление на сервере
С Mac (из папки проекта):

```bash
tar czf /tmp/attendance.tgz --exclude node_modules --exclude data --exclude .env .
scp /tmp/attendance.tgz root@ВАШ_СЕРВЕР:/tmp/
```

На сервере:

```bash
cd /opt/attendance
tar xzf /tmp/attendance.tgz
# перезапуск: убить старый node, затем
set -a && source .env && set +a
nohup node server.js > /tmp/attendance.log 2>&1 &
```

Папку `data/` и файл `.env` на сервере **не** кладите в архив (`--exclude .env`).

## Мониторинг: UptimeRobot
Проверяет снаружи, что сайт отвечает (если VPS упал — алерт в Telegram/email).

1. Зарегистрируйтесь на [uptimerobot.com](https://uptimerobot.com) (бесплатный план).
2. **Add New Monitor**:
   - Monitor Type: **HTTPS**
   - Friendly Name: `Посещаемость`
   - URL: `https://attendance.shkola-krasnogorskaya.ru` (ваш домен)
   - Interval: **5 minutes**
3. My Settings → Alert Contacts → добавьте email или Telegram (бот UptimeRobot).
4. Привяжите контакт к монитору.

Этого достаточно, чтобы знать, когда сервер недоступен «для всех».

## Логи «Нет связи» с телефонов
Если у одного учителя ошибка, а сервер жив — событие кладётся в очередь на телефоне и уходит на сервер, когда связь появится.

На VPS:

```bash
tail -50 /opt/attendance/data/client-errors.log
# или следить вживую:
tail -f /opt/attendance/data/client-errors.log
```

В каждой строке JSON: время, IP, URL запроса, ФИО/роль (если были в сессии), `online`, User-Agent.

## Бекапы на Mac (раз в 2 дня)
Скрипт забирает консистентную копию `attendance.db` в `~/Backups/attendance/` (хранит ~30 последних).

Нужен рабочий SSH без пароля к серверу (`ssh root@195.133.199.57` уже заходит). На сервере должен быть `sqlite3` (`apt install sqlite3`).

Один раз на Mac:

```bash
cd "/Users/alyonaartemeva/Frontend Projects/attendance"
./scripts/install-backup-launchd.sh
```

Проверка вручную:

```bash
./scripts/backup-from-server.sh
ls ~/Backups/attendance
```

Лог автозапуска: `~/Library/Logs/attendance-backup.log`.  
Отключить: `launchctl unload ~/Library/LaunchAgents/com.attendance.backup.plist`.

Переменные (по желанию): `ATT_BACKUP_HOST`, `ATT_BACKUP_REMOTE`, `ATT_BACKUP_DIR`.

## Нагрузочный тест
```bash
set -a && source .env && set +a
BASE_URL=http://localhost:3000 TEACHER_CODE="$TEACHER_CODE" node scripts/load-test.mjs -c 30 -d 20
```

## Ограничения
- Работает только при наличии интернета (офлайн открывается оболочка, но отметки не сохраняются).
- Один общий код для всех учителей.
- Сессия входа на телефоне ~90 дней.
