#!/usr/bin/env bash
# One-shot setup of the Datadash OKX.AI agent on a fresh Ubuntu 24.04 server (DigitalOcean droplet or similar).
#
# From your Mac, in the repo folder, copy the code (and .env) up, then run this as root:
#   rsync -az --exclude node_modules --exclude 'data/*.json' --exclude reports ./ root@SERVER:/opt/okx-src/
#   ssh root@SERVER 'bash /opt/okx-src/deploy/setup-ubuntu.sh'
#
# It installs everything and stops before the logins, which need you in a browser. It prints those steps at the
# end. Safe to run again: each step checks whether it is already done.
set -euo pipefail

APP_USER=datadash
APP_HOME=/home/$APP_USER
APP_DIR=$APP_HOME/okx-smart-money-agent
SRC=${SRC:-/opt/okx-src}
NODE_MAJOR=22

[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }
[ -f "$SRC/package.json" ] || { echo "No code in $SRC. rsync the repo there first (see the top of this file)."; exit 1; }
# Ubuntu's .bashrc returns early in non-interactive shells, before nvm's lines, so load nvm and ~/.local/bin here.
as_app() {
  sudo -iu "$APP_USER" bash -c "export PATH=\$HOME/.local/bin:\$PATH; [ -s \$HOME/.nvm/nvm.sh ] && . \$HOME/.nvm/nvm.sh; $1"
}

echo "==> System packages, firewall, swap"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl rsync ufw unattended-upgrades >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null   # outbound only: nothing needs to reach this server except SSH
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> User $APP_USER (SSH with the same key as root)"
if ! id "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER" >/dev/null
fi
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  install -m 600 -o "$APP_USER" -g "$APP_USER" /root/.ssh/authorized_keys "$APP_HOME/.ssh/authorized_keys"
fi
# Only the agent's own service may be managed without a password.
cat > /etc/sudoers.d/$APP_USER <<EOF
$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start okx-smart-money-agent, /usr/bin/systemctl stop okx-smart-money-agent, /usr/bin/systemctl restart okx-smart-money-agent, /usr/bin/systemctl status okx-smart-money-agent, /usr/bin/journalctl -u okx-smart-money-agent *
EOF
chmod 440 /etc/sudoers.d/$APP_USER
# The okx-a2a daemon runs as a systemd user service; lingering keeps it up without an open SSH session.
loginctl enable-linger "$APP_USER"

echo "==> Code into $APP_DIR"
rsync -a --delete --exclude node_modules --exclude 'data/*.json' "$SRC/" "$APP_DIR/"
[ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Node $NODE_MAJOR (nvm), pnpm"
as_app '[ -s "$HOME/.nvm/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null'
as_app ". \$HOME/.nvm/nvm.sh && nvm install $NODE_MAJOR >/dev/null && nvm alias default $NODE_MAJOR >/dev/null"
as_app 'command -v pnpm >/dev/null || npm install -g pnpm@11 >/dev/null'

echo "==> Claude Code (the AI runtime OKX's daemon calls on events). Installed before Onchain OS so its skills land in ~/.claude"
as_app 'command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash'

echo "==> Onchain OS CLI, skills and the OKX A2A daemon"
as_app 'command -v onchainos >/dev/null || npx -y @okxweb3/onchainos-installer install'
as_app 'command -v okx-a2a >/dev/null || npm install -g @okxweb3/a2a-node >/dev/null'

# Interactive SSH sessions need ~/.local/bin too, for `claude` and `onchainos`.
as_app 'grep -q "local/bin" ~/.bashrc || sed -i "1i export PATH=\"\$HOME/.local/bin:\$PATH\"" ~/.bashrc'

echo "==> Provider skill for the agent session"
as_app "install -d \$HOME/.claude/skills/datadash-smart-money-asp && cp $APP_DIR/skill/SKILL.md \$HOME/.claude/skills/datadash-smart-money-asp/SKILL.md"

echo "==> App dependencies and tests"
as_app "cd $APP_DIR && pnpm install --frozen-lockfile >/dev/null && pnpm test >/dev/null && echo 'tests pass'"

echo "==> systemd unit (installed, not started: it needs the logins first)"
NODE_BIN=$(as_app 'dirname "$(command -v node)"')
sed -e "s#^Environment=PATH=.*#Environment=PATH=$APP_HOME/.local/bin:$NODE_BIN:/usr/local/bin:/usr/bin:/bin#" \
  "$APP_DIR/deploy/okx-smart-money-agent.service" > /etc/systemd/system/okx-smart-money-agent.service
systemctl daemon-reload
systemctl enable okx-smart-money-agent >/dev/null

cat <<EOF

Setup done. Now the logins, as $APP_USER:  ssh $APP_USER@$(hostname -I | awk '{print $1}')

  1. Onchain OS, with the Google account that owns agent #13854 (arpitbhalla2001@gmail.com):
       onchainos wallet login                  # open the loginUrl it prints on your laptop
       onchainos wallet login --phase poll     # waits until you finish in the browser
  2. Claude Code:  run 'claude', then /login, and open the URL it prints. Then /exit.
  3. OKX messaging:  okx-a2a doctor --fix      # must end with "ready": true
  4. Check:        onchainos agent gate-check --role asp
  5. Start delivery:  sudo systemctl start okx-smart-money-agent
                      sudo journalctl -u okx-smart-money-agent -f    # look for "gate-check ready" and "round done"

Then, from that same login, submit the listing for review:
  onchainos agent activate --agent-id 13854 --preferred-language en-US
EOF
