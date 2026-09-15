# 🚀 VELVET LAUNCHER - STATUS E CONTEXTO COMPLETO DO PROJETO

## 1. Informações Gerais
* **Servidor:** Velvet Abyss RP (30 jogadores)
* **IP do Servidor:** `velvet.enxada.host`
* **Versão do Minecraft:** `1.20.1`
* **ModLoader:** Minecraft Forge `47.4.10` (`net.minecraftforge:forge:1.20.1-47.4.10`)
* **Repositório GitHub Oficial:** `https://github.com/puppet04/VelvetLauncher`
* **Release de Assets:** `v1.0.0` (ID: `388137871`)
* **URL do distribution.json:** `https://raw.githubusercontent.com/puppet04/VelvetLauncher/main/distribution.json`

---

## 2. O que foi feito e está 100% pronto:
1. **Identidade Visual e Branding:**
   * Todo o projeto foi renomeado de Drafonn para **Velvet Launcher** / **Velvet Server**.
   * Textos de boas-vindas personalizados ("Convite Real" em `app/assets/lang/_custom.toml`).
   * Tradução completa e revisada em `app/assets/lang/pt_BR.toml`.
   * Ícones Windows multi-resolução (`16x16` até `256x256`) convertidos a partir de `logo.png` para `app/assets/images/logo.ico` e `build/icon.ico` (barra de tarefas e `.exe`).
   * 13 imagens de fundo em HD comprimidas (economia de ~34MB).
2. **Distribuição e Assets na Nuvem (GitHub Releases):**
   * Modpack enxugado e atualizado: removidos `zmedievalmusic` (290MB) e addon `forbidden_tiers` (Iron's Spells); shaders atualizados para **Complementary r5.9.1 + EuphoriaPatches 1.10.1**; `Mods.zip` em **887MB** e distribuição oficial em **255 módulos**.
   * `distribution.json` atualizado, validado e sincronizado no GitHub.
3. **Recursos Especiais e Otimizações Implementadas:**
   * **Auto-Cleaner de Mods Antigos (`landing.js`):** Remove automaticamente qualquer `.jar` antigo da pasta `mods/` que não esteja no `distribution.json` (incluindo o mod de músicas removido).
   * **Auto-Hide durante Gameplay (`landing.js`):** Oculta a janela do launcher assim que o Minecraft abre (economizando 150-300MB de RAM e zerando uso de GPU) e restaura automaticamente ao sair do jogo.
   * **Flags JVM de Baixa Latência (`configmanager.js`):** Calibradas para Java 17 e MC 1.20.1 (G1GC com 130ms de pausa, regiões de 8M, PreTouch e DisableExplicitGC, eliminando micro-stutters e travamentos).
   * **Correção do Ping do Servidor (`landing.js`):** Protocolo atualizado para `763` (Minecraft 1.20.1), garantindo status e contagem de jogadores precisa.
   * **Aceleração de Download (`helios-core`):** Conexões HTTP persistentes (Keep-Alive) e fila aumentada para 25 downloads paralelos.
   * **Otimização do Instalador (`build/afterPack.js`):** Remove locales, licenças e DLLs WebGPU (`dxcompiler.dll`, `dxil.dll`), economizando quase 100MB instalados.
   * **Liberdade de Config:** Pastas `config/`, opções de vídeo, áudio e shaders customizados nunca são apagados nem resetados.
   * **Contador de Tempo de Jogo (`playtime.json`):** Salva o tempo jogado no perfil permanentemente (`⏱️ 0m`, `1h 30m`, `2d 5h`).
   * **Customização Profunda (Branding Velvet):** Pasta de dados alterada para `.velvet` (`configmanager.js`), identificador do jogo `VelvetLauncher` (`processbuilder.js`), feeds de atualização e links apontando para `puppet04/VelvetLauncher` (`settings.js`, `uicore.js`).
   * **DevTools Condicional (`settings.js`):** O botão 'DevTools Console' agora é inteligente: visível apenas durante desenvolvimento (`npm start`) e oculto automaticamente para os jogadores na versão final (`.exe`).
4. **Instaladores Oficiais Compilados (em `HeliosLauncher-master/dist/`):**
   * `Velvet Launcher-setup-1.0.0-VERSAO-ANTERIOR.exe` (~112MB): Versão original mantida a salvo como backup.
   * `Velvet Launcher-setup-1.0.0-NOVO-LOGO.exe` (~115MB): Versão nova com a arte do Velvet em `logo.png` e `LogoCarregando.png` (corte circular 50%).
   * `Velvet Launcher-setup-1.0.0.exe` (~115MB): Instalador padrão atualizado.

---

## 3. Comandos Úteis do Projeto (executados em `HeliosLauncher-master`):
* `npm start`: Inicia o launcher em modo de desenvolvimento na tela.
* `npm run dist:win`: Compila o novo instalador para Windows `.exe`.
* `node ../sync_launcher_code.js`: Sincroniza código com o GitHub (`puppet04/VelvetLauncher`).
