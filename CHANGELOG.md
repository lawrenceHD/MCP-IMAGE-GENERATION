# 📝 Changelog - Antigravity Image Studio (MCP & Web Server)

Toutes les modifications notables apportées à ce projet sont documentées dans ce fichier.
Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) et ce projet adhère à [Semantic Versioning](https://semver.org/lang/fr/).

---

## [2.2.0] - 2026-10-20

### Sécurité
- L'accès HTTP distant exige maintenant un opt-in explicite, un jeton API de 32 caractères minimum, une origine publique HTTPS et des listes Host/CORS précises.
- Les routes API et images exigent un jeton Bearer lorsqu'il est configuré ; ce jeton est obligatoire en mode distant. Les images sont servies uniquement depuis des noms générés validés avec des en-têtes `private, no-store`.
- Ajout de limites sur les requêtes, la concurrence, les réponses fournisseurs, la taille des images, le base64 intégré et le stockage. Les erreurs HTTP ne révèlent plus les chemins locaux ni les messages bruts des fournisseurs.
- Chaque exécution Antigravity CLI dispose d'un espace temporaire isolé, d'un environnement réduit et du sandbox par défaut. Le mode distant refuse les dérogations de permissions dangereuses.
- Validation des entrées du cache et des signatures d'images, refus des liens symboliques de stockage, galerie restreinte aux fichiers générés et ajout d'en-têtes de sécurité.
- Réponses de recherche visuelle bornées ; données transmises aux fournisseurs, risques du jeton partagé, configuration distante et limites restantes documentés dans `SECURITY.md`.
- Mise à jour de `sharp` vers la branche corrigée 0.35.5 et désactivation du décodage SVG en défense complémentaire. L'audit des dépendances après la mise à jour a signalé zéro vulnérabilité.

### Corrections
- La galerie et l'aperçu envoient maintenant le jeton Bearer pour charger les images protégées, sans exposer les chemins locaux dans les réponses HTTP.
- Correction de la gestion CORS multi-origines et des erreurs JSON pour les requêtes invalides ou trop volumineuses.

---

## [2.1.0] - 2026-10-20

### 🚀 Nouveautés & Fonctionnalités majeures
- **Cascade Triple Moteur Intelligente :**
  1. `gemini-2.5-flash-image` (Google API directe, ultra-rapide 2-4s dès activation du billing).
  2. `gemini-2.0-flash-preview-image-generation` / `imagen-4.0-fast-generate-001` (modèles de génération directe).
  3. **Antigravity CLI Subagent (`image-generator`) :** Moteur autonome 100% gratuit avec sous-agent interne Google Imagen/Nano Banana, sans carte bancaire requise.
- **Détection instantanée du statut sans facturation (`limit: 0`) :**
  - Si la clé Google AI Studio est en palier gratuit sans carte bancaire (quota image = 0), l'erreur `429 RESOURCE_EXHAUSTED` est interceptée en **0,4 seconde** sans bloquer sur des retries inutiles, et bascule immédiatement sur le CLI gratuit.
- **6 Nouveaux Presets de Style pour Charte Graphique & Mockups :**
  - `brand_mockup` : Mockup produit photoréaliste sur fond studio neutre avec ombres douces.
  - `logo_brand` : Identité visuelle vectorielle avec typographie précise et harmonie de couleurs.
  - `charte_graphique` : Planche de style complète (palette de couleurs, typographie, déclinaisons logo).
  - `ui_mockup` : Mockup d'interface sur cadre d'appareil (mobile/desktop) avec reflets réalistes.
  - `packaging` : Rendu packaging 3D studio (textures mat/brillant/foil, e-commerce ready).
  - `advertising` : Visuel publicitaire percutant et haute fidélité pour campagnes.
- **Nouveaux Ratios d'Aspect :**
  - `4:5` (Format portrait optimisé réseaux sociaux / Instagram).
  - `3:2` (Format paysage classique photographie reflex).
- **Extension du Timeout d'Exécution CLI :**
  - `CLI_TIMEOUT_MS` configurable (par défaut `600000` ms = 10 minutes) pour laisser le temps nécessaire à la synthèse haute fidélité du sous-agent en mode gratuit.

### 🛡️ Sécurité & Fiabilité
- Protection DNS Rebinding (`allowedHosts` et vérification stricte en mode local).
- Rejet strict des requêtes Cross-Origin simples non autorisées.
- Validation rigoureuse des images de référence (restriction au sous-dossier `generated_images` ou data-URI base64 valides, limitation à 8 Mo par image).
- Assainissement (sanitization) strict des prompts contre les injections de commande terminal et tentatives d'évasion d'agent (`promptHelper.js`).
- Gestion propre de l'arrêt des processus sous Windows (`taskkill /F /T`) pour éliminer tout processus zombie.

### ⚡ Performance & Cache
- **Cache SHA-256 déterministe atomique :** Écriture sécurisée par fichier temporaire + renommage atomique, gestion de la concurrence multi-processus. Temps de réponse mesuré : **2,8 millisecondes**.
- **Compression miniatures WebP :** Utilisation de `sharp` pour générer des vignettes de 512px (~19 Ko vs 940 Ko) pour économiser les tokens d'affichage dans les contextes LLM.

---

## [2.0.0] - 2026-10-19

### 🚀 Nouveautés
- Intégration du SDK MCP officiel `@modelcontextprotocol/sdk`.
- Outil MCP `generate_image` avec schéma Zod complet et annotations de sécurité.
- Ressources MCP `image://recent` et `stats://server`.
- Serveur HTTP Express v5 avec interface web interactive (`public/index.html`).
- File d'attente asynchrone `AsyncQueue` bornée contre les attaques DoS et saturations mémoire.
- Support du mode standard I/O (`--stdio`) avec redirection des logs vers `stderr`.

---

## [1.0.0] - 2026-10-15

### 🚀 Version Initiale
- Script de génération basique via appel au binaire `agy.exe`.
- Sortie d'image locale brute dans le répertoire de travail.
