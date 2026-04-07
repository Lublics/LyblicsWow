# Architecture — LyblicsWow

> Panel de gestion pour addons WoW — Node.js + WebSocket

## Stack

- **Node.js** (serveur)
- **Express** (serveur HTTP)
- **ws** (WebSocket)
- Frontend statique (HTML dans `public/`)

## Structure

```
LyblicsWow/
├── server.js               # Serveur Express + WebSocket (panel web)
├── agent.js                # Agent de collecte de données WoW
├── test-parse.js           # Script de test parsing
├── public/
│   ├── index.html          # Interface web du panel
│   └── placeholder.txt
├── install-agent.bat       # Installation de l'agent (Windows)
├── start-agent.bat         # Démarrage de l'agent (Windows)
├── uninstall-agent.bat     # Désinstallation de l'agent (Windows)
├── package.json
└── .env.example
```

## Description

- **`server.js`** : expose un panel web via HTTP et communique en temps réel via WebSocket
- **`agent.js`** : agent local qui collecte les données WoW (logs, addons) et les envoie au serveur
- Les scripts `.bat` servent à gérer l'agent comme service Windows

## Flux

```
WoW Addon → agent.js (lecture logs) → WebSocket → server.js → panel HTML
```
