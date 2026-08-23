#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Запустите через sudo: sudo bash install.sh"; exit 1; fi
command -v apt-get >/dev/null || { echo "Поддерживаются только Debian/Ubuntu-серверы с apt-get."; exit 1; }

APP_DIR="/opt/pifpaf-creators"
ENV_FILE="$APP_DIR/.env"
UPDATE_ONLY=0
if [[ "${1:-}" == "--update" ]]; then UPDATE_ONLY=1; fi

get_env() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

prompt_value() {
  local prompt="$1" default_value="${2:-}" required="${3:-1}" value
  if [[ -n "$default_value" ]]; then
    read -rp "$prompt [$default_value]: " value
    value="${value:-$default_value}"
  else
    read -rp "$prompt: " value
  fi
  if [[ "$required" == "1" && -z "$value" ]]; then echo "Поле обязательно."; exit 1; fi
  printf '%s' "$value"
}

prompt_secret() {
  local prompt="$1" default_value="${2:-}" required="${3:-1}" value
  if [[ -n "$default_value" ]]; then
    read -rsp "$prompt [оставить текущий]: " value; echo
    value="${value:-$default_value}"
  else
    read -rsp "$prompt: " value; echo
  fi
  if [[ "$required" == "1" && -z "$value" ]]; then echo "Поле обязательно."; exit 1; fi
  printf '%s' "$value"
}

normalize_domain() {
  local domain="$1"
  domain="${domain#http://}"; domain="${domain#https://}"; domain="${domain%%/*}"; domain="${domain%%:*}"; domain="${domain%.}"; domain="${domain,,}"
  printf '%s' "$domain"
}

read_existing_domain() {
  if [[ -f /etc/nginx/sites-available/pifpaf-creators ]]; then
    awk '/server_name/ { gsub(";", "", $2); print $2; exit }' /etc/nginx/sites-available/pifpaf-creators
  fi
}

check_dns() {
  local domain="$1"
  if command -v getent >/dev/null && getent ahosts "$domain" >/dev/null; then return 0; fi
  echo "DNS для $domain не найден. Создайте A/AAAA-запись на IP этого сервера и повторите установку."
  echo "Именно из-за этого Let's Encrypt показывает NXDOMAIN и не выдаёт сертификат."
  return 1
}

wait_for_health() {
  local port="$1"
  for attempt in {1..30}; do
    if curl --fail --silent --show-error "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Приложение не ответило на http://127.0.0.1:$port/api/health за 30 секунд."
  echo "Последние логи pifpaf-creators:"
  journalctl -u pifpaf-creators -n 80 --no-pager || true
  echo "Проверка процесса и порта:"
  systemctl status pifpaf-creators --no-pager || true
  if command -v ss >/dev/null; then ss -ltnp "sport = :$port" || true; fi
  return 1
}

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$SOURCE_DIR/server.js" && -f "$SOURCE_DIR/index.html" ]] || { echo "Запускайте скрипт из папки проекта PifPaf Creators."; exit 1; }

EXISTING_PORT="$(get_env PORT || true)"
EXISTING_ADMIN_EMAIL="$(get_env ADMIN_EMAIL || true)"
EXISTING_ADMIN_PASSWORD="$(get_env ADMIN_PASSWORD || true)"
EXISTING_APIFY_TOKEN="$(get_env APIFY_TOKEN || true)"
EXISTING_APIFY_ACTOR="$(get_env APIFY_ACTOR || true)"
EXISTING_SYNC_INTERVAL="$(get_env SYNC_INTERVAL_MS || true)"
EXISTING_DOMAIN="$(read_existing_domain || true)"

if [[ "$UPDATE_ONLY" == "1" ]]; then
  [[ -f "$ENV_FILE" ]] || { echo "Для --update нужен существующий $ENV_FILE. Сначала выполните обычную установку."; exit 1; }
  DOMAIN="$EXISTING_DOMAIN"
  PORT="${EXISTING_PORT:-3000}"
  ADMIN_EMAIL="$EXISTING_ADMIN_EMAIL"
  ADMIN_PASSWORD="$EXISTING_ADMIN_PASSWORD"
  APIFY_TOKEN="$EXISTING_APIFY_TOKEN"
  APIFY_ACTOR="${EXISTING_APIFY_ACTOR:-apify/instagram-scraper}"
  SYNC_INTERVAL_MS="${EXISTING_SYNC_INTERVAL:-21600000}"
  [[ -n "$DOMAIN" ]] || { echo "Не нашёл домен в /etc/nginx/sites-available/pifpaf-creators."; exit 1; }
else
  while true; do
    DOMAIN="$(normalize_domain "$(prompt_value 'Домен для кабинета (например, creators.example.com)' "$EXISTING_DOMAIN")")"
    if [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$DOMAIN" == *.* ]]; then break; fi
    echo "Не удалось распознать домен. Введите, например: creators.example.com"
  done
  EMAIL="$(prompt_value "Email для Let's Encrypt" "${EXISTING_ADMIN_EMAIL:-}")"
  PORT="$(prompt_value "Порт приложения" "${EXISTING_PORT:-3000}")"
  ADMIN_EMAIL="$(prompt_value "Email первого администратора" "${EXISTING_ADMIN_EMAIL:-}")"
  ADMIN_PASSWORD="$(prompt_secret "Пароль первого администратора" "$EXISTING_ADMIN_PASSWORD")"
  APIFY_TOKEN="$(prompt_secret "Apify API token (можно оставить пустым и добавить позже)" "$EXISTING_APIFY_TOKEN" 0)"
  APIFY_ACTOR="$(prompt_value "Apify actor" "${EXISTING_APIFY_ACTOR:-apify/instagram-scraper}" 0)"
  SYNC_INTERVAL_MS="$(prompt_value "Интервал автосинхронизации, мс" "${EXISTING_SYNC_INTERVAL:-21600000}" 0)"
  [[ ${#ADMIN_PASSWORD} -ge 12 ]] || { echo "Пароль администратора должен содержать не менее 12 символов."; exit 1; }
fi

# The service runs as www-data. Do not run it directly from /root: www-data cannot
# traverse that directory even when files inside it are chowned correctly.
echo "Устанавливаем/обновляем Node.js, Nginx и Certbot…"
apt-get update
apt-get install -y curl nginx certbot python3-certbot-nginx nodejs
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || { echo "Требуется Node.js 18 или новее, найден: $(node --version)"; exit 1; }

umask 077
install -d -m 755 "$APP_DIR"
cp -a "$SOURCE_DIR"/. "$APP_DIR"/
cat >"$APP_DIR/.env" <<EOF_ENV
PORT=$PORT
NODE_ENV=production
DATA_DIR=$APP_DIR/data
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
APIFY_TOKEN=$APIFY_TOKEN
APIFY_ACTOR=${APIFY_ACTOR:-apify/instagram-scraper}
SYNC_INTERVAL_MS=${SYNC_INTERVAL_MS:-21600000}
EOF_ENV
mkdir -p "$APP_DIR/data"
cat >/etc/systemd/system/pifpaf-creators.service <<EOF_SERVICE
[Unit]
Description=PifPaf Creators dashboard
After=network.target
[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
User=www-data
Group=www-data
[Install]
WantedBy=multi-user.target
EOF_SERVICE
chown -R www-data:www-data "$APP_DIR"
chown root:www-data "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"
cat >/etc/nginx/sites-available/pifpaf-creators <<EOF_NGINX
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 1m;
  location / { proxy_pass http://127.0.0.1:$PORT; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }
}
EOF_NGINX
ln -sf /etc/nginx/sites-available/pifpaf-creators /etc/nginx/sites-enabled/pifpaf-creators
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable --now pifpaf-creators nginx
systemctl restart pifpaf-creators nginx

if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  echo "Сертификат для $DOMAIN уже есть, certbot пропущен."
elif [[ "$UPDATE_ONLY" == "1" ]]; then
  echo "Режим --update не выпускает новый сертификат. Для первого выпуска запустите: sudo bash install.sh"
else
  check_dns "$DOMAIN"
  certbot --nginx --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" --redirect
fi

systemctl is-active --quiet pifpaf-creators || { journalctl -u pifpaf-creators -n 80 --no-pager; exit 1; }
wait_for_health "$PORT"
echo "Готово: https://$DOMAIN"
