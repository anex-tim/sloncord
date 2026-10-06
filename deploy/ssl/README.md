# Собственный SSL-сертификат для install.sh

Положите **только на сервер** (или в `deploy/ssl/` рядом с репозиторием **перед** `sudo bash deploy/install.sh`):

| Файл | Содержимое |
|------|------------|
| `fullchain.pem` | **Доменный** сертификат, затем цепочка (промежуточные/корневые) — все блоки `-----BEGIN CERTIFICATE-----` **подряд**, как в инструкции хостинга. |
| `privkey.pem`   | Приватный ключ: один блок `-----BEGIN … PRIVATE KEY-----` … `-----END … KEY-----` |

**Права на сервере** выставит скрипт: цепочка `0644`, ключ `0600`, каталог `/etc/ssl/sloncord/`.

**Не коммитьте** эти файлы в git. Каталог защищён `.gitignore`.

Переменные окружения (опционально, если файлы лежат не в `deploy/ssl/`):

- `SLONCORD_CUSTOM_SSL=1` — форсировать режим «свой сертификат»;
- `SLONCORD_SSL_FULLCHAIN_SOURCE=/path/to/fullchain.pem`
- `SLONCORD_SSL_PRIVKEY_SOURCE=/path/to/privkey.pem`

Если `deploy/ssl/fullchain.pem` **и** `deploy/ssl/privkey.pem` существуют, **Let’s Encrypt (certbot) пропускается**, Nginx сразу поднимается с HTTPS.

`server_name` в Nginx — из `SLONCORD_SERVER_NAME` (по умолчанию `sloncord.ru`). Укажите **все** домены из сертификата, например:

```bash
sudo SLONCORD_SERVER_NAME="www.sloncord.ru sloncord.ru" bash deploy/install.sh
```

После публикации ключа в открытом виде **перевыпустите** сертификат/ключ у провайдера и положите новые файлы.
