# LyblicsWow - https://wow.lyblics.com/

Panel de suivi en temps réel pour les addons WoW — **Mists of Pandaria Classic**.

## Vue d'ensemble

LyblicsWow est un système en deux parties qui relie les addons WoW à un dashboard web en temps réel :

```
WoW Addon → WoWChatLog.txt → agent.js (PC local) → server.js (VPS) → WebSocket → Dashboard
```

- **Agent local** (`agent.js`) : tourne sur votre PC, lit le chat log WoW toutes les secondes et envoie les données au serveur
- **Serveur** (`server.js`) : hébergé sur VPS, reçoit les données et les diffuse en WebSocket au dashboard
- **Dashboard** (`public/index.html`) : interface web temps réel avec profil de personnage, équipement, raids, montures, etc.

## Addons suivis

| Addon | Données collectées |
|---|---|
| LyblicsSync | Zone, sous-zone, or, FPS, latence |
| LyblicsFishing | Sessions de pêche |
| LyblicsMining | Nœuds minés |
| LybicsFPS | Historique FPS |
| LyblicsAutoRepair | Réparations automatiques |
| LyblicsAutoSellJunk | Ventes automatiques |
| LyblicsBagSpaceTracker | Espace sac |
| LyblicsCustomNameplateColors | Couleurs de nameplates |

## Stack

- **Node.js** + **Express** — serveur HTTP
- **ws** — WebSocket temps réel
- **Blizzard API** — profils de personnage, icônes, montures
- Frontend HTML/CSS/JS statique (pas de framework)

## Installation

### Prérequis

- Node.js 18+
- Un VPS accessible publiquement (pour le serveur)
- World of Warcraft — Mists of Pandaria Classic

### Serveur (VPS)

```bash
git clone https://github.com/Lyblics/LyblicsWow.git
cd LyblicsWow
npm install
cp .env.example .env
# Éditer .env avec vos clés
npm start
```

### Agent (PC local)

1. Copier `agent.js` sur votre PC
2. Copier `.env.example` en `.env` et renseigner `SERVER_URL`, `API_KEY` et les chemins WoW
3. Lancer l'installation du service Windows :

```
install-agent.bat
```

Ou démarrer manuellement :

```bash
node agent.js
```

## Configuration

Créer un fichier `.env` à partir de `.env.example` :

```env
# Serveur (VPS)
PORT=3000
API_KEY=une-cle-secrete-aleatoire

# Blizzard API — https://develop.battle.net/access/clients
BLIZZARD_CLIENT_ID=your_blizzard_client_id
BLIZZARD_CLIENT_SECRET=your_blizzard_client_secret

# Agent (PC local)
SERVER_URL=https://your-server-url.com
# API_KEY=      (même clé que le serveur)
# WOW_PATH=     (chemin vers le dossier WoW Classic)
# WOW_ACCOUNT_PATH=  (chemin vers SavedVariables de votre compte)
```

## Protocole Chat Log

L'addon LyblicsSync envoie ses données via self-whisper toutes les 3 secondes :

```
##LYB##name|class|level|zone|subzone|gold|fps|latHome|latWorld##
```

L'agent lit les nouvelles lignes de `WoWChatLog.txt` et transmet au serveur via `POST /api/sync/live`.

## Scripts Windows

| Script | Description |
|---|---|
| `install-agent.bat` | Installe l'agent comme service Windows |
| `start-agent.bat` | Démarre l'agent manuellement |
| `uninstall-agent.bat` | Désinstalle le service |

## API Endpoints

| Endpoint | Description |
|---|---|
| `POST /api/sync/live` | Réception données temps réel (agent) |
| `POST /api/sync/addons` | Réception SavedVariables (reload/logout) |
| `GET /api/character/full` | Profil complet via Blizzard API |
| `GET /api/icon/item/:id` | Icône d'item (proxy + cache) |
| `GET /api/icon/mount/:id` | Icône de monture (proxy + cache) |
| `GET /api/mounts/guide` | Guide complet des montures (1574 entrées) |
