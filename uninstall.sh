#!/bin/bash
# Desativa e remove a extensão (o código do projeto continua onde está).
UUID=monitor-rapido@ederfmatos
gnome-extensions disable "$UUID" 2>/dev/null
rm -f "$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "Removido. Saia e entre de novo na sessão para sumir da barra."
