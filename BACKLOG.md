# 🎯 Backlog & Roadmap Technique - Antigravity Image Studio

Ce document sert de référence pour tout développeur ou agent IA reprenant le projet. Il détaille les tâches planifiées, priorisées pour l'intégration dans l'application web de génération de chartes graphiques et mockups.

---

## 📌 Priorité 1 : Intégration dans l'App Web de Charte Graphique & Mockups

### 🔲 [EPIC-01] Pipeline dédié Logo ➔ Charte Graphique ➔ Mockups
- [ ] **Déclinaison multi-mockups en lot (Batch Generation) :**
  - Permettre un endpoint `POST /api/generate/batch` prenant un logo (en référence) et générant simultanément ou en séquence :
    1. Carte de visite / Papeterie (`brand_mockup`)
    2. Enseigne extérieure / Bureau (`advertising`)
    3. Packaging produit 3D (`packaging`)
    4. Écran mobile / Application (`ui_mockup`)
- [ ] **Extraction et injection automatique de palette de couleurs :**
  - Module d'analyse chromatique (via `sharp` ou `colorthief`) pour extraire les 3 couleurs dominantes (primaire, secondaire, accent) depuis un logo téléversé.
  - Injection automatique de ces codes hexadécimaux dans le prompt enrichi (`promptHelper.js`).

### 🔲 [EPIC-02] Notifications en temps réel & Progression (SSE / WebSockets)
- [ ] **Server-Sent Events (SSE) sur `/api/generate/progress` :**
  - Actuellement, les requêtes HTTP longues peuvent sembler bloquées pour un utilisateur web lors de l'utilisation du moteur CLI (~9 minutes).
  - Implémenter un endpoint SSE diffusant les étapes :
    - `0%` : Réception de la requête & vérification du cache
    - `20%` : Lancement du moteur (Direct API ou CLI)
    - `50%` : Traitement par le modèle de diffusion
    - `90%` : Compression & génération de miniature
    - `100%` : Image prête avec URL publique

---

## 📌 Priorité 2 : Optimisations du Moteur & Performances

### 🔲 [EPIC-03] Isolation du CLI agy contre la surcharge de mémoire
- [ ] **Exclusion stricte des hooks claude-mem lors des runs images :**
  - Lancer le sous-processus `agy` avec une variable d'environnement dédiée (ex: `CLAUDE_MEM_DISABLE=true` ou projet isolé) pour éviter d'exécuter `worker-service.cjs` à chaque démarrage d'outil d'image, économisant 45 à 60 secondes de latence morte.
- [ ] **Gestion avancée des quotas CLI :**
  - Améliorer l'analyse des logs d'`agy` pour détecter plus finement les resets de quota glissants de Google DeepMind.

### 🔲 [EPIC-04] Bascule transparente vers l'API Directe (Pay-As-You-Go)
- [ ] **Validation automatique du statut de facturation :**
  - Au démarrage du serveur, tester un ping direct vers `gemini-2.5-flash-image`. Si le billing est actif, afficher un badge vert dans la console et dans l'interface web (`Mode Haute Vitesse : 2s`).
- [ ] **Support des clés de secours (Multi-Keys Fallback) :**
  - Permettre de définir une liste de clés `GEMINI_API_KEY_1, GEMINI_API_KEY_2` avec rotation automatique en cas d'atteinte de quota RPM (15 requêtes/minute).

---

## 📌 Priorité 3 : Expérience Développeur & Déploiement

### 🔲 [EPIC-05] Interface Web de Studio & Playground (`public/index.html`)
- [ ] Ajouter les 6 nouveaux sélecteurs de styles de charte graphique dans le menu déroulant de l'interface web.
- [ ] Ajouter le bouton de téléchargement haute résolution et le bouton "Copier le prompt enrichi".
- [ ] Prévisualisation dynamique du ratio d'aspect choisi (cadre adaptatif 1:1, 16:9, 9:16, 4:5, 3:2).

### 🔲 [EPIC-06] Conteneurisation & Déploiement Production
- [ ] Écriture d'un `Dockerfile` multi-stage Node 20 / Linux Alpine avec support optionnel de Sharp C++.
- [ ] Configuration PM2 / `ecosystem.config.js` pour redémarrage automatique en cas de crash.
- [ ] Script de nettoyage automatique du dossier `generated_images/` (suppression des fichiers de plus de 30 jours non marqués comme favoris).
