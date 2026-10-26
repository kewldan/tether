# Tether (adb-gui)

Кроссплатформенный (Linux, macOS, Windows) десктопный GUI для Android Debug
Bridge. Продукт называется **Tether**, репозиторий — `adb-gui`. Цель —
красивый, быстрый, keyboard-first инструмент, который заменяет 90%
повседневных `adb`-команд: устройства, зеркалирование экрана, файлы,
приложения, logcat, shell, настройки разработчика.

## Дизайн

- Макеты: [docs/design/project/](docs/design/project/) — по одному
  `*.dc.html` на экран, индекс с названиями в `canvas.json`. Источник —
  Claude Design (https://claude.ai/artifact/PSiF26pWWLc7Pg9D7Qrrv9).
- Текст экрана без разметки: `python3 scripts/design-text.py <board>`. Для
  точных размеров, отступов и цветов читай сам `.dc.html` (стили в `<style>`
  внутри `<helmet>`, переменные `--fg`, `--bg2`… соответствуют токенам ниже).
- Доски дизайн-системы: `Main.dc.html` (токены, типографика, правила),
  `Components.dc.html` (компоненты и состояния), `Motion.dc.html` (пружины).
- Соответствие переменных макета и токенов: `--bg`→`background`,
  `--bg2`→`sidebar`/`muted`, `--card`→`card`, `--elev`→`popover`,
  `--hover`→`accent`, `--active`→`selected`, `--border`→`border`,
  `--border2`→`input`, `--fg`→`foreground`, `--fg2`→`secondary-foreground`,
  `--fg3`→`muted-foreground`, `--brand`→`brand`, `--primary`→`primary`,
  `--ok/--warn/--err/--info`→`success/warning/error/info`,
  `--lv…--lf`→`log-v…log-f`, `--c1…--c5`→`chart-1…chart-5`.
- Правила дома: один акцент (Iris) — только главное действие, текущее место
  и ссылки; статусные цвета только для реального состояния и всегда точка +
  слово; плотность: сетка 4 px, строки 32 px, текст 13 px; тени только у
  плавающих слоёв.

## Ключевые решения

1. **Используем настоящий adb, не реализуем USB-протокол сами.** Свой
   USB-стек конфликтует с чужим adb-сервером за интерфейс, требует драйверов
   и повторяет работу Google. Настоящий adb даёт совместимость с Android
   Studio, scrcpy и т. д. — все работают с одним сервером.
2. **adb в системе не обязателен.** Если не нашли — предлагаем скачать
   platform-tools в один клик с `dl.google.com` в папку данных приложения.
   Сами бинарник **не распространяем** (лицензия Android SDK): пользователь
   скачивает его сам и явно принимает лицензию в диалоге. Ставим в
   `<app_data>/platform-tools` (`adb/installer.rs`): качаем во временную
   папку, распаковываем, проверяем наличие adb и только потом подменяем
   старую копию. Linux arm64 Google не публикует — там только пакетный
   менеджер.
3. **Не парсим вывод CLI.** Бинарник `adb` вызываем только для
   `adb start-server` (и `adb pair`, пока не реализуем pairing сами). Всё
   остальное — напрямую по протоколу adb-сервера на `localhost:5037`
   (`SERVICES.TXT`, `SYNC.TXT` в AOSP): `host:track-devices`,
   `host:transport:<serial>`, `shell,v2:`, `sync:`, `exec:`, `reverse:` …
   Вывод утилит на устройстве (`dumpsys`, `pm`, `getprop`) парсим в Rust,
   с тестами на реальных снимках вывода.
4. **Зеркалирование экрана — scrcpy-server.** `scrcpy-server` (Apache 2.0)
   лежит в ресурсах с зафиксированной версией, пушится на устройство,
   видеопоток H.264 декодируется во фронтенде через WebCodecs, управление —
   по control-сокету scrcpy.

## Стек

- **Оболочка:** Tauri 2 (последняя 2.x; 3.0 пока alpha — не берём). Окно
  без системного заголовка: на macOS `titleBarStyle: Overlay` (светофор
  поверх нашего заголовка), на Windows/Linux `decorations: false`
  (`tauri.windows.conf.json`, `tauri.linux.conf.json`) и свои кнопки.
- **Бэкенд:** Rust (stable, edition 2024), `tokio`, `serde`, `thiserror`,
  `reqwest` + `zip` (только deflate) для загрузки platform-tools.
- **Фронтенд:** React 19 + TypeScript 7 (strict) + Vite 8, Tailwind CSS v4,
  shadcn/ui на **Base UI** (`@base-ui/react`, стиль `base-nova`, не Radix),
  lucide-react, шрифты Inter + JetBrains Mono (fontsource), Motion
  (`motion/react`) для анимаций, Zustand для UI-состояния, TanStack Query
  для запросов к бэкенду, TanStack Virtual для длинных списков, cmdk для
  палитры, sonner для тостов, i18next для текстов.
- **Пакетный менеджер:** bun. **Линтер и форматтер:** Biome (`biome.json`).
- Зависимости держим на последних версиях. Компоненты shadcn добавляем через
  `bunx --bun shadcn@latest add <name>`; `cn` импортируется из пакета `cn`
  (так генерирует shadcn) — после `shadcn add` замени на `@/lib/utils`: там `cn` знает нашу шкалу `text-caption`/`text-small`…, иначе размер теряется при слиянии с цветом. Сгенерированные `src/components/ui/*` можно
  править под дизайн-систему (кнопки, бейджи, kbd уже приведены).

## Структура

```
src-tauri/src/
  adb/              # протокол и инфраструктура adb
    locator.rs      # поиск adb
    installer.rs    # загрузка platform-tools
    server.rs       # AdbServer: framing, start-server, open_device, exec, shell
    devices.rs      # track-devices-l
  device/           # высокоуровневые операции над устройством (props, …)
  commands/         # #[tauri::command] — тонкий слой, по модулю на фичу
  error.rs          # AppError → { kind, message, hint }
  state.rs          # AppState и lock()
src/
  app/
    App.tsx         # поиск adb → онбординг или AppShell
    sections.tsx    # реестр всех страниц (id, иконка, группа, lazy page)
    navigation.ts   # zustand: текущая страница + params
    shell/          # Titlebar, Sidebar, DeviceSwitcher, StatusBar, CommandPalette
  components/
    layout/Page.tsx # стандартная страница: шапка 52 px, крошки, actions, тело
    status/         # StatusDot, deviceTone
    ui/             # shadcn
  features/<name>/  # всё, что относится к фиче: страница, компоненты, api.ts
  dev/              # моки бэкенда для браузера (только dev)
  lib/              # tauri.ts (общие типы и команды), settings, theme,
                    # motion, i18n, platform, tasks, adb
  locales/<lang>/<namespace>.json
```

## Как добавлять фичу

- **Страница** уже зарегистрирована в `src/app/sections.tsx` и лежит в
  `src/features/<name>/<Name>Page.tsx` (сейчас заглушка `ComingSoon`).
  Заменяешь заглушку — реестр трогать не нужно. Страница строится на
  `<Page title actions toolbar body>`.
- **Выбранное устройство:** `useSelectedDevice()`, `useReadySerial()` из
  `features/devices/store.ts` (serial есть, только если устройство в
  состоянии `device`). Навигация: `useNavigation().navigate(id, params)`.
- **Бэкенд фичи:** модуль `src-tauri/src/device/<name>.rs` (или
  `adb/<proto>.rs` для протоколов, например `sync.rs`), команды —
  `src-tauri/src/commands/<name>.rs`, регистрация — строкой в
  `generate_handler!` в `lib.rs` и `pub mod` в `commands/mod.rs`. Общие
  примитивы `AdbServer`: `open_device(serial, service)` (сырой поток
  сервиса), `exec(serial, cmd)` (stdout без PTY, бинарно-безопасно),
  `exec_text`, `shell`. Ошибки — `AppError`; для ошибок устройства есть
  общие `Device(String)` и `InvalidInput(String)`.
- **Фронтенд-API фичи:** `src/features/<name>/api.ts` с типами и обёртками
  `invoke`/`Channel`; в `src/lib/tauri.ts` — только общее.
- **Тексты:** свой namespace `src/locales/{en,ru}/<name>.json`,
  `useTranslation("<name>")`. Русские тексты на ~30% длиннее — вёрстка
  должна это выдерживать. Общие слова — `common`.
- **Долгие операции** (передачи, установки, bugreport) публикуют прогресс в
  `useTasks` (`src/lib/tasks.ts`) — его показывает индикатор в сайдбаре.
- **Сочетания клавиш:** запись в реестре `src/lib/shortcuts/registry.ts`
  (клавиши по умолчанию, `scope`), подпись — `shortcuts.<id>` в
  `locales/*/settings.json`, обработка — `useShortcut(id, handler)`,
  подсказки — `<ShortcutKbd id>` / `useShortcutTitle`. Тогда сочетание
  появляется в «Настройки › Сочетания клавиш», переназначается и
  проверяется на конфликты. Не хардкодь `⌘` и `hasMod` для новых сочетаний.
- **Анимации:** только пружины из `src/lib/motion.ts` (`spring.snappy`,
  `smooth`, `bouncy`) по таблице из `Motion.dc.html`. Logcat, терминал и
  графики не анимируются.
- **Моки для браузера:** `src/dev/mocks/<name>.ts` экспортирует
  `{ command: handler }` для команд фичи с правдоподобными данными. Тогда
  `bun run dev` показывает страницу в обычном браузере без Tauri.

## Правила

- Команды Tauri возвращают `Result<T, AppError>`; `AppError` сериализуется в
  `{ kind, message, hint? }`, фронтенд показывает `hint` как подсказку.
- Долгие операции идут как задачи с id: прогресс — через Channel, отмена —
  отдельной командой.
- Потоки (logcat, track-devices, видео, передачи) — через Tauri Channels, не
  через глобальные события.
- Всё, что относится к устройству, адресуется по `serial`; UI поддерживает
  несколько устройств одновременно.
- Разрушительные действия — с подтверждением (AlertDialog), самые опасные —
  с вводом имени пакета; где можно — тост с «Отменить».
- Ошибки человеческим языком; сырой вывод adb — под «Подробнее».

## Поиск adb (порядок)

1. Путь из настроек приложения.
2. `PATH`.
3. `$ANDROID_HOME/platform-tools`, `$ANDROID_SDK_ROOT/platform-tools`.
4. Типичные места:
   - macOS: `~/Library/Android/sdk/platform-tools`, `/opt/homebrew/bin`,
     `/usr/local/bin`;
   - Windows: `%LOCALAPPDATA%\Android\Sdk\platform-tools`, scoop, winget;
   - Linux: `~/Android/Sdk/platform-tools`, `/usr/bin`.
5. Своя копия в папке данных приложения.

Если adb-сервер уже запущен (порт 5037 слушается) — используем его, не
перезапускаем.

Ручная установка, которую показываем в онбординге:
- macOS: `brew install --cask android-platform-tools`
- Windows: `winget install Google.PlatformTools`
- Debian/Ubuntu: `sudo apt install adb`
- Fedora: `sudo dnf install android-tools`
- Arch: `sudo pacman -S android-tools`

## Платформенные грабли

- **Linux:** без udev-правил устройство в состоянии `no permissions`.
  Диагностируем и предлагаем `android-udev-rules` или правило через `pkexec`.
  WebKitGTK: проверять поддержку WebCodecs перед зеркалированием.
- **Windows:** устройство не видно → чаще всего драйвер. Пути с пробелами и
  кириллицей — тестировать. Запущенный `adb.exe` нельзя заменить на диске.
- **macOS:** обычно работает из коробки; нужна подпись и нотаризация.

## Стиль кода

- Rust: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`. Без
  `unwrap()` вне тестов. Парсеры вывода утилит — с юнит-тестами на реальных
  снимках вывода.
- TS: strict, без `any`, Biome (`bun run lint`, `bun run format`).
  Компоненты — функции, `PascalCase.tsx`; хуки — `useThing.ts`.
- Цвета, радиусы, тени, размеры шрифтов — только токены из `src/index.css`
  (`bg-sidebar`, `text-muted-foreground`, `text-small`, `rounded-md`,
  `bg-success/12`…), без хардкода hex в компонентах.

## Команды

```bash
bun install
bun run tauri dev     # приложение целиком
bun run dev           # только фронтенд в браузере, с моками (src/dev)
bun run build         # tsc + vite build
bun run lint          # biome check
bun run format        # biome check --write
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test --test live_server -- --ignored --nocapture
cd src-tauri && cargo test --test live_download -- --ignored --nocapture
```

`live_server` ходит в настоящий adb-сервер (нужен установленный adb),
`live_download` качает ~10 МБ с `dl.google.com` во временную папку.

## Git

Работаем и коммитим прямо в `main`. Коммиты — Conventional Commits
(`feat(files): …`, `fix(logcat): …`, `ci: …`), автор — владелец репозитория,
никакой ИИ-атрибуции (трейлеров, упоминаний) в коммитах и файлах.
Параллельные агенты работают во временных worktree; их коммиты переносятся в
`main`, временные ветки удаляются.
