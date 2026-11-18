#!/bin/bash
# Instala (via symlink) e ativa a extensão. No Wayland, vale a partir do próximo login.
set -e
UUID=monitor-rapido@ederfmatos
DIR="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$DIR"
ln -sfn "$(cd "$(dirname "$0")" && pwd)" "$DIR/$UUID"
chmod +x "$(dirname "$0")/sampler.py"
gnome-extensions enable "$UUID" 2>/dev/null || \
  gsettings set org.gnome.shell enabled-extensions "$(python3 -c "
import ast,subprocess
l=ast.literal_eval(subprocess.check_output(['gsettings','get','org.gnome.shell','enabled-extensions'],text=True).replace('@as ',''))
print(l if '$UUID' in l else l+['$UUID'])")"
echo "Pronto. Saia e entre de novo na sessão para o widget aparecer na barra."
