# 🏛️ Architecture Technique - Antigravity Image Studio (v2.2.0)

Ce document décrit l'architecture interne, le cycle de vie des requêtes, la gestion des erreurs et l'organisation du code du serveur `antigravity-mcp-image-server`.

---

## 1. Vue d'ensemble du Système

Le serveur est conçu comme une passerelle unifiée à double protocole :
1. **Protocole MCP (Model Context Protocol) via Stdio (`--stdio`) :** Permet à des clients IA comme Antigravity IDE, Claude Desktop ou Cursor d'appeler l'outil `generate_image` directement dans une conversation.
2. **API REST HTTP (Port 3333 par défaut) :** Permet à une application web externe (React, Next.js, Vue, Node.js) de générer des images et mockups via des requêtes JSON standard.

```
                           ┌────────────────────────────┐
                           │      Client Externe        │
                           │  (App Web / IDE MCP Host)  │
                           └──────────────┬─────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
         [ Mode HTTP REST ]                              [ Mode MCP Stdio ]
          Port 3333 / Express                             Standard I/O Transport
                  │                                               │
                  └───────────────────────┬───────────────────────┘
                                          │
                                          ▼
                               ┌─────────────────────┐
                               │  sanitizePrompt()   │ (Normalisation et taille)
                               │ buildEnhancedPrompt │ (Application presets styles/ratios)
                               └──────────┬──────────┘
                                          │
                                          ▼
                               ┌─────────────────────┐
                               │  ImageCache (SHA256)│ (Clé: hash(prompt+style+ratio+refs))
                               └──────────┬──────────┘
                                          │
                      ┌───────────────────┴───────────────────┐
             [ Cache Hit (2,8 ms) ]                  [ Cache Miss ]
                      │                                       │
                      ▼                                       ▼
            Retour immédiat JSON                  ┌───────────────────────┐
                                                  │ runEngines() Cascade  │
                                                  └───────────┬───────────┘
                                                              │
            ┌─────────────────────────────────────────────────┼─────────────────────────┐
            ▼                                                 ▼                         ▼
   [ Moteur 1 : Gemini Free ]                     [ Moteur 2 : Google Paid ]   [ Moteur 3 : agy CLI ]
   gemini-2.0-flash-preview / 3.1                gemini-2.5-flash-image /     Processus local agy.exe
   API Directe (si dispo)                         Imagen 4 Fast (Billing ON)   Sous-agent image-generator
            │                                                 │                         │
            └─────────────────────────┬───────────────────────┴─────────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ Sauvegarde disque local   │
                        │ `./generated_images/`     │
                        │ + Mise à jour index cache │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ Sharp Thumbnail (WebP)    │ (Si mode MCP ou miniature demandée)
                        │ + Réponse Client          │
                        └───────────────────────────┘
```

---

## 2. Cascade des Moteurs de Génération (`lib/generator.js`)

Le serveur implémente une cascade à tolérance de panne avec détection instantanée du statut de facturation :

### Moteur 1 : Google Free API
- **Modèle :** `gemini-2.0-flash-preview-image-generation` ou `gemini-3.1-flash-image`.
- **Comportement :** Testé en premier dès que `GEMINI_API_KEY` est défini.
- **Gestion du statut :** Si Google renvoie `limit: 0` (clé gratuite sans carte bancaire), l'erreur est détectée en **0,4 seconde** sans bloquer sur des retries.

### Moteur 2 : Google Paid API (Production)
- **Modèles :** `gemini-2.5-flash-image` (pour images de référence / image-to-image) et `imagen-4.0-fast-generate-001` (texte vers image).
- **Vitesse :** 2 à 4 secondes.
- **Activation :** Automatique dès qu'un compte Google Cloud avec facturation activée utilise la clé.

### Moteur 3 : Antigravity CLI Fallback (Gratuit sans carte)
- **Modèle :** Sous-agent `image-generator` orchestré par `agy.exe`.
- **Fonctionnement :**
  - Spawne `agy.exe` dans un espace dédié temporaire (`%TEMP%\agy-image-runs`).
  - L'orchestrateur délègue au sous-agent spécialisé dans la synthèse d'image.
  - Copie les références dans l'espace temporaire isolé, puis n'accepte qu'un fichier image créé dans cet espace.
  - Le CLI est lancé sans shell, avec un environnement réduit et le sandbox actif par défaut.
- **Timeout :** 600 secondes (10 minutes) paramétrable via `CLI_TIMEOUT_MS`.

---

## 3. Système de Cache Déterministe SHA-256 (`lib/cache.js`)

Le cache est basé sur le contenu (Content-Addressable) :
1. **Calcul de clé :**
   ```javascript
   computeKey(prompt, style, aspectRatio, referenceHashes)
   // Hash SHA-256 de : `${prompt.trim().toLowerCase()}|${style}|${aspectRatio}|${refs}`
   ```
2. **Écriture atomique :**
   Pour éviter la corruption de fichier lors d'accès concurrents (ex: serveur HTTP + client MCP simultanés), l'index `.cache_index.json` est écrit dans un fichier temporaire exclusif, nommé avec un aléa cryptographique, puis renommé atomiquement via `fs.renameSync`.
3. **Validation d'intégrité :**
   Lors d'un `get()`, le cache vérifie physiquement la présence du fichier sur le disque. Si le fichier a été supprimé manuellement, l'entrée est invalidée automatiquement.

---

## 4. Presets Métier & Enrichissement (`lib/promptHelper.js`)

Pour répondre aux exigences des chartes graphiques et mockups, les styles injectent des descripteurs optiques et artistiques spécifiques :

| Preset | Directives injectées |
| :--- | :--- |
| `brand_mockup` | Rendu produit commercial, studio neutre, ombres douces, cohérence chromatique de marque. |
| `logo_brand` | Rendu vectoriel net, composition scalable, typographie soignée, esthétique corporate. |
| `charte_graphique` | Planche de style globale, nuanciers de couleurs, hiérarchie typographique, déclinaisons. |
| `ui_mockup` | Rendu écran mobile/desktop haute fidélité avec reflets réalistes et cadrage de présentation. |
| `packaging` | Packaging produit 3D réaliste (textures mat/brillant/dorure), éclairage studio e-commerce. |
| `advertising` | Visuel publicitaire percutant, grand contraste, qualité héro-campagne. |

---

## 5. File d'Attente & Gestion de Concurrence (`lib/queue.js`)

Pour empêcher l'épuisement des ressources système sous Windows :
- `cliQueue` : Concurrence limitée à **1** (`MAX_CONCURRENCY=1`) pour éviter de lancer plusieurs sessions lourdes `agy` en parallèle.
- `apiQueue` : Concurrence jusqu'à **4** (`API_CONCURRENCY=4`) pour l'API directe Google.
- `inFlight` : Map de déduplication en vol. Si deux requêtes identiques arrivent simultanément, elles partagent la même Promise de génération.
- L'API HTTP accepte au plus quatre corps de génération simultanés ; huit appels de génération maximum sont admis au total par processus. Les files ont également une taille maximale.

---

## 6. Frontières de sécurité

- HTTP reste lié à la boucle locale par défaut. Toute origine distante exige explicitement `ALLOW_REMOTE_ACCESS=true`, un jeton de 32 caractères minimum, des valeurs exactes pour `ALLOWED_HOSTS` et `CORS_ORIGIN`, ainsi qu'une origine publique HTTPS.
- Toutes les routes API et images sont authentifiées lorsque le jeton est configuré ; en accès distant, le jeton est obligatoire. Les images HTTP ne révèlent pas de chemin local et sont envoyées avec `no-store`.
- La galerie utilise une route de miniatures WebP 96 × 96 avec limite de décodage et de concurrence ; la route originale sert les images complètes protégées.
- Les entrées, fichiers image, réponses des fournisseurs, files d'attente, accès HTTP et quota disque ont des limites. Les réponses d'erreur HTTP ne retournent pas de chemins internes ni d'erreurs brutes du fournisseur.
- La recherche d'inspiration appelle Brave/Pinterest côté serveur. Les URL de vignettes et de pages sont limitées à HTTPS ; le navigateur charge les vignettes depuis leurs domaines source.
- Le détail des réglages, des limites et des risques restants se trouve dans [SECURITY.md](SECURITY.md).

## 7. Structure des Fichiers

```
antigravity-mcp-image-server/
├── server.js               # Point d'entrée principal (Modes Stdio & HTTP Express)
├── package.json            # Dépendances (@modelcontextprotocol/sdk, express, sharp, zod)
├── .env                    # Configuration active (clé API, ports, timeouts)
├── .env.example            # Gabarit documenté de configuration
├── README.md               # Guide utilisateur et d'intégration
├── CHANGELOG.md            # Historique des versions et correctifs
├── BACKLOG.md              # Feuille de route et tâches planifiées
├── ARCHITECTURE.md         # Ce document technique
├── lib/
│   ├── generator.js        # Moteur principal, cascade triple et appel agy
│   ├── cache.js            # Cache SHA-256 atomique
│   ├── promptHelper.js     # Sanitisation et presets de styles/ratios
│   ├── inspiration.js      # Recherche d'images Brave/Pinterest et cache mémoire borné
│   └── queue.js            # File d'attente asynchrone bornée
├── public/
│   └── index.html          # Interface web interactive et galerie de test
└── generated_images/       # Répertoire de stockage des images et index cache
    ├── .cache_index.json   # Index cryptographique du cache
    └── .agy_quota.json     # État persistant du quota CLI
```
