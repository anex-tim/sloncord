# GitHub: код и релизы Windows-клиента

- **Репозиторий** — исходники монорепозитория Sloncord.
- **Релизы** — установщик `Sloncord-Setup-x64.exe`; кнопка «Обновить» в десктопе смотрит **GitHub Releases**, не VPS.

## Первичная настройка

1. Создайте репозиторий на GitHub (например `your-user/sloncord`).
2. Укажите его в переменной окружения или замените значение по умолчанию в `shared/sloncordGithub.mjs`:
   ```bash
   set SLONCORD_GITHUB_REPO=your-user/sloncord
   ```
3. Инициализируйте git локально, добавьте `origin`, запушьте `main`:
   ```bash
   git init -b main
   git add -A
   git commit -m "Initial commit"
   gh repo create your-user/sloncord --public --source=. --push
   ```

## Публикация новой версии клиента

1. Поднимите `version` в `apps/desktop/package.json`.
2. Локально (нужны `gh auth login`):
   ```bash
   npm run publish:desktop
   ```
   Или через CI: тег `git tag v3.1.2 && git push origin v3.1.2` — workflow `.github/workflows/release-desktop.yml`.

3. Закоммитьте обновлённый `releases/desktop-release.json` (fallback для клиента).

## Деплой бэкенда (VPS)

Только API + веб без `.exe`:

```bash
npm run deploy
npm run deploy:upload   # без пересборки
```

Старый режим (сборка desktop/moderation и заливка на сервер):

```bash
npm run deploy:with-clients
```
