# adb-gui

Кроссплатформенный (Linux, macOS, Windows) десктопный GUI для Android Debug
Bridge. Цель — красивый, быстрый, keyboard-first инструмент, который заменяет
90% повседневных `adb`-команд: устройства, зеркалирование экрана, файлы,
приложения, logcat, shell, настройки разработчика.

Статус: каркас. Есть поиск adb, загрузка platform-tools в один клик, клиент
протокола adb-сервера, живой список устройств (`track-devices-l`) и `getprop`; UI — временный, до готового
дизайна.

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
4. **Зеркалирование экрана — scrcpy-server.** `scrcpy-server.jar`
   (Apache 2.0) лежит в ресурсах с зафиксированной версией, пушится на
   устройство, видеопоток H.264/H.265 декодируется во фронтенде через
   WebCodecs, управление — по control-сокету scrcpy.

## Стек

- **Оболочка:** Tauri 2 (последняя 2.x; 3.0 пока alpha — не берём).
- **Бэкенд:** Rust (stable, edition 2024), `tokio`, `serde`, `thiserror`.
  `reqwest` + `zip` (только deflate) для загрузки platform-tools. Позже:
  `tracing`.
- **Фронтенд:** React 19 + TypeScript 7 (strict) + Vite 8, Tailwind CSS v4,
  shadcn/ui на **Base UI** (`@base-ui/react`, стиль `base-nova`, не Radix),
  иконки lucide-react, шрифт Geist. Позже: TanStack Query для запросов к бэкенду, Zustand для
  UI-состояния, TanStack Virtual для длинных списков (logcat, файлы,
  приложения), xterm.js для shell, cmdk для командной палитры.
- **Пакетный менеджер:** pnpm.
- Зависимости держим на последних версиях. Компоненты shadcn добавляем через
  `pnpm dlx shadcn@latest add <name>`; `cn` импортируется из пакета `cn`
  (так генерирует shadcn), реэкспорт — `@/lib/utils`.

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

Найденный adb проверяем через `adb version`, предупреждаем о версиях старше
~2 лет. Если adb-сервер уже запущен (порт 5037 слушается) — используем его,
не перезапускаем.

Ручная установка, которую показываем в онбординге:
- macOS: `brew install --cask android-platform-tools`
- Windows: `winget install Google.PlatformTools`
- Debian/Ubuntu: `sudo apt install adb`
- Fedora: `sudo dnf install android-tools`
- Arch: `sudo pacman -S android-tools`

## Платформенные грабли

- **Linux:** без udev-правил устройство в состоянии `no permissions`.
  Диагностируем и предлагаем `android-udev-rules` или правило через `pkexec`.
- **Windows:** устройство не видно → чаще всего драйвер. Ссылка на Google USB
  Driver / драйвер производителя. Пути с пробелами и кириллицей — тестировать.
- **macOS:** обычно работает из коробки; нужна подпись и нотаризация.

## Архитектура

```
src-tauri/src/
  adb/
    locator.rs      # поиск adb по списку выше
    installer.rs    # загрузка и распаковка platform-tools
    server.rs       # запуск сервера, TCP-клиент к :5037, framing
    devices.rs      # track-devices → события во фронтенд
    shell.rs        # shell,v2 с разделением stdout/stderr и exit code
    sync.rs         # STAT/LIST/SEND/RECV, прогресс передачи
    forward.rs      # forward/reverse
  device/           # высокоуровневые операции: props, battery, packages,
                    # processes, settings — парсинг вывода утилит
  mirror/           # scrcpy-server: push, запуск, сокеты, control-сообщения
  commands/         # #[tauri::command] — тонкий слой над device/ и adb/
  error.rs          # AppError → { kind, message, hint }
  state.rs          # AppState: найденный adb, AdbServer, фоновые задачи
src/
  app/              # роутинг, layout, провайдеры
  components/ui/    # shadcn-компоненты (генерируются CLI, правим токенами)
  features/<name>/  # devices, mirror, files, apps, logcat, shell, perf, …
  lib/tauri.ts      # типизированные обёртки над invoke/listen
  index.css         # дизайн-токены (CSS-переменные shadcn + свои)
```

Правила:
- Команды Tauri возвращают `Result<T, AppError>`; `AppError` сериализуется в
  `{ kind, message, hint? }`, фронтенд показывает `hint` как подсказку.
- Долгие операции (push/pull, install, загрузка platform-tools, bugreport)
  идут как задачи с id: прогресс — событиями, отмена — отдельной командой.
- Потоки (logcat, track-devices, видео) — через Tauri Channels, не через
  глобальные события.
- Всё, что относится к устройству, адресуется по `serial`; UI поддерживает
  несколько устройств одновременно.

## Стиль кода

- Rust: `cargo fmt`, `cargo clippy -- -D warnings`. Без `unwrap()` вне тестов.
- TS: strict, ESLint + Prettier. Без `any`. Компоненты — функции,
  `PascalCase.tsx`; хуки — `useThing.ts`.
- Цвета, радиусы и отступы — только через токены из `src/index.css`, без
  хардкода hex в компонентах.
- Тексты UI — через i18n (en по умолчанию, ru).

## Команды

```bash
pnpm install
pnpm tauri dev        # запуск в режиме разработки
pnpm tauri build      # сборка дистрибутива
pnpm build            # tsc + vite build (проверка фронтенда)
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test --test live_server -- --ignored --nocapture
cd src-tauri && cargo test --test live_download -- --ignored --nocapture
```

`live_server` ходит в настоящий adb-сервер (нужен установленный adb),
`live_download` качает ~10 МБ с `dl.google.com` во временную папку.
ESLint/Prettier ещё не настроены.

## Git

Работаем и коммитим прямо в `main`, ветки не создаём.
