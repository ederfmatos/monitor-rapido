# Monitor Rápido

Extensão do GNOME Shell que coloca na barra o uso de **CPU** e **RAM** e, com um clique, mostra os programas que mais consomem recursos, com um botão para encerrá-los.

- **Na barra:** `CPU% RAM%`. Fica amarelo a partir de 75% e vermelho a partir de 90%.
- **No menu:** barras de CPU, memória e swap, e os 8 programas que mais consomem, ordenados por CPU ou por memória.
- **Agrupado por programa:** todos os processos do `chrome` viram uma linha `chrome ×14`, e o ✕ encerra o grupo inteiro.
- **Encerrar:** manda `SIGTERM`. Se o programa não sair em 3 s, manda `SIGKILL`.
- **Seguro:** só oferece o ✕ para processos do seu usuário. Processos do sistema aparecem como "(sistema)", e peças da sessão (`gnome-shell`, `Xwayland`, `pipewire`, `dbus`…) nunca podem ser encerradas por aqui.
- **Leve:** o texto da barra lê só `/proc/stat` e `/proc/meminfo` a cada 2 s. A lista de processos só é coletada com o menu aberto, por um script Python separado (`sampler.py`), para não travar a interface do Shell.

Testado no Zorin OS 18 (GNOME Shell 46, Wayland). Declara suporte ao GNOME 45 a 48.

## Instalação

```bash
git clone https://github.com/ederfmatos/monitor-rapido.git ~/projects/monitor-rapido
cd ~/projects/monitor-rapido
./install.sh
```

No Wayland, o widget aparece depois de sair e entrar de novo na sessão. O `install.sh` cria um symlink em `~/.local/share/gnome-shell/extensions/`, então editar o código aqui vale a partir do próximo login.

Para remover: `./uninstall.sh`.

## Como funciona

| Arquivo | Papel |
|---|---|
| `extension.js` | Botão da barra, menu e fluxo de encerramento |
| `procstats.js` | Leitura rápida de CPU/RAM, agrupamento e cálculo de % por processo |
| `sampler.py` | Lê `/proc` uma vez e imprime JSON. Roda fora do processo do Shell |

A **% de CPU** de cada programa é relativa à máquina inteira: a soma de todos bate com o total do cabeçalho. A **memória** é a residente privada (RSS menos páginas compartilhadas), parecida com o que o Monitor do Sistema mostra.

## Licença

MIT
