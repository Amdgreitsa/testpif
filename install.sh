#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Запустите через sudo: sudo bash install.sh"; exit 1; fi
command -v apt-get >/dev/null || { echo "Поддерживаются только Debian/Ubuntu-серверы с apt-get."; exit 1; }
while true; do
  read -rp "Домен для кабинета (например, creators.example.com): " DOMAIN
  # Accept a copied URL as well as a bare domain: https://creators.example.com/path
  # Certbot only needs the hostname, so remove the protocol, path, port and trailing dot.
  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%%/*}"
  DOMAIN="${DOMAIN%%:*}"
  DOMAIN="${DOMAIN%.}"
  DOMAIN="${DOMAIN,,}"
  if [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$DOMAIN" == *.* ]]; then
    break
  fi
  echo "Не удалось распознать домен. Введите, например: creators.example.com"
done
read -rp "Email для Let's Encrypt: " EMAIL
read -rp "Порт приложения [3000]: " PORT; PORT=${PORT:-3000}
read -rp "Email первого администратора: " ADMIN_EMAIL
read -rsp "Пароль первого администратора: " ADMIN_PASSWORD; echo
read -rsp "Apify API token (оставьте пустым, если добавите позже): " APIFY_TOKEN; echo
[[ -n "$DOMAIN" && -n "$EMAIL" ]] || { echo "Домен и email обязательны."; exit 1; }
[[ -n "$ADMIN_EMAIL" && -n "$ADMIN_PASSWORD" ]] || { echo "Данные администратора обязательны."; exit 1; }
[[ ${#ADMIN_PASSWORD} -ge 12 ]] || { echo "Пароль администратора должен содержать не менее 12 символов."; exit 1; }
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$APP_DIR/server.js" && -f "$APP_DIR/index.html" ]] || { echo "Запускайте скрипт из папки проекта PifPaf Creators."; exit 1; }
echo "Устанавливаем Node.js, Nginx и Certbot…"
apt-get update
apt-get install -y curl nginx certbot python3-certbot-nginx nodejs
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || { echo "Требуется Node.js 18 или новее, найден: $(node --version)"; exit 1; }
umask 077
cat >"$APP_DIR/.env" <<EOF
PORT=$PORT
NODE_ENV=production
DATA_DIR=$APP_DIR/data
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
APIFY_TOKEN=$APIFY_TOKEN
APIFY_ACTOR=apify/instagram-scraper
SYNC_INTERVAL_MS=21600000
EOF
mkdir -p "$APP_DIR/data"
cat >/etc/systemd/system/pifpaf-creators.service <<EOF
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
EOF
chown -R www-data:www-data "$APP_DIR"
chown root:www-data "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"
cat >/etc/nginx/sites-available/pifpaf-creators <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 1m;
  location / { proxy_pass http://127.0.0.1:$PORT; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }
}
EOF
ln -sf /etc/nginx/sites-available/pifpaf-creators /etc/nginx/sites-enabled/pifpaf-creators
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable --now pifpaf-creators nginx
certbot --nginx --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" --redirect
systemctl is-active --quiet pifpaf-creators || { journalctl -u pifpaf-creators -n 50 --no-pager; exit 1; }
curl --fail --silent --show-error "http://127.0.0.1:$PORT/api/health" >/dev/null
echo "Готово: https://$DOMAIN"
