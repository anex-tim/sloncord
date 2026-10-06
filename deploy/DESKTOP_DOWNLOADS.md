# Десктоп Sloncord: сборка, версия и кнопка «Скачать .exe» на сайте

На сайте в шапке чата (только в **браузере под Windows**, не в Electron) показывается кнопка **«Скачать .exe»**, если доступен манифест `downloads/desktop-release.json` с `"available": true` и ненулевым размером.

## Как устроено

| Файл | Назначение |
|------|------------|
| `apps/web/public/downloads/desktop-release.json` | Версия, URL установщика, размер, дата (попадает в `dist` после `vite build`). |
| `apps/web/public/downloads/Sloncord-Setup-x64.exe` | Стабильное имя файла для ссылки (копируется скриптом после NSIS). |
| `apps/desktop/scripts/publish-to-web.mjs` | Берёт свежий `.exe` из `apps/desktop/release/`, копирует в `public/downloads/`, обновляет JSON. |
| `apps/web/.gitignore` | Игнорирует `*.exe` в `public/downloads/`, чтобы не коммитить большие бинарники по ошибке. |

Версия в манифесте берётся из **`apps/desktop/package.json`** → поле **`version`**. Перед релизом увеличьте её (например `1.0.1`).

## Локальная схема (один раз за релиз)

1. **Увеличьте версию** в `apps/desktop/package.json` (`"version": "1.0.1"`).
2. Соберите десктоп (включает веб для вшивки в Electron + NSIS + публикацию в `public`):

   ```bash
   npm run build:desktop
   ```

   (из корня репозитория; это `npm run build -w @sloncord/desktop`).

   Либо из `apps/desktop`:

   ```bash
   npm run build
   ```

   Скрипт `publish-to-web.mjs` запускается **в конце** `build` и кладёт `Sloncord-Setup-x64.exe` + обновлённый `desktop-release.json` в **`apps/web/public/downloads/`**.

3. **Соберите веб** для деплоя на сервер:

   ```bash
   npm run build:web
   ```

4. **Задеплойте** на сервер как обычно: в `wwwroot` должен попасть весь `apps/web/dist/`, включая каталог **`downloads/`** (и `index.html`, `assets/`, …).

5. **Установщик на сервере:** файл `.exe` в репозитории по `.gitignore` не хранится. Варианты:
   - копируете `apps/web/public/downloads/Sloncord-Setup-x64.exe` на сервер **вручную** (scp/rsync) в тот же путь внутри опубликованного `wwwroot/downloads/`;
   - либо храните артефакты в CI (GitHub Actions / др.) и выкладываете на хост вместе с `dist`.

Пока `Sloncord-Setup-x64.exe` **не** залит на сервер, кнопка может исчезнуть (манифест с `available: false` или `size: 0` с фронтом не показывается).

## Повторно только обновить EXE+JSON без полного `electron-builder`

Если установщик уже собран в `release/`:

```bash
cd apps/desktop
npm run publish-web
cd ../web
npm run build
```

## Проверка

- В браузере на Windows: откройте сайт → в шапке чата должна быть **«Скачать .exe»** (при валидном манифесте).
- Прямая ссылка (подставьте свой домен): `https://ваш-домен/downloads/desktop-release.json`
- Установщик: `https://ваш-домен/downloads/Sloncord-Setup-x64.exe`

## Ошибка: `app.asar` / `release` заняты другим процессом

`electron-builder` не может перезаписать `app.asar`, если **уже запущен** тот же Sloncord (часто тест из `release\win-unpacked\Sloncord.exe`), **Electron** после `npm run dev` / `start`, или **Проводник** с фокусом на `win-unpacked`.

1. Не оставляйте Sloncord, запущенный **из** `release\win-unpacked`, на время сборки.
2. Перед `electron-builder` цепочка `build` вызывает **`kill-sloncord-for-build.mjs`**: завершает **только `Sloncord.exe`** (чтобы не закрывать Cursor/VS Code — они тоже на Electron) и ждёт 2 с. Если и после этого EPERM — вручную снимите лишние `Electron` из `node_modules` (dev server) в диспетчере и закройте `release\` в Проводнике.
3. `clean:release` по-прежнему сносит `release/` (rename / `rmdir` / Node).

**Папка «Рабочий стол»** в связке с OneDrive иногда даёт залипания: при повторе ошибок вынесите репозиторий, например, в `C:\dev\Sloncord`, и добавьте **исключение** для папки проекта в срочном сканировании **Windows Defender**.

**Блокировка `app.asar` при выключенном Защитнике** бывает от: **индекса поиска Windows** (параметры → Поиск → ведение поиска на классическом диске — исключить папку проекта), **синхронизации OneDrive** с «Рабочий стол», **запущенного Sloncord** из `release\win-unpacked`, отдельного **антивируса** (не тот же, что Microsoft Defender), **Контролируемого доступа к папкам** (в настройках Защитника отдельный переключатель). В `package.json` десктопа задано **`"asar": false`**: приложение пакуется **без** одного архива `app.asar` (файлы в `resources\app\`), что у `electron-builder` на Windows снимает частый EPERM на шаге пересборки asar.

## Замечания

- **Electron** на Windows кнопку не показывает (уже открыт десктоп).
- **Не Windows** — кнопка не показывается.
- Если API на другом хосте, чем фронт, убедитесь, что **статика** `downloads/*` отдаётся **с того же origin**, с которого открыт клиент, либо настройте CORS/прокси; для типичного деплоя «один Kestrel + wwwroot» всё на одном домене.
