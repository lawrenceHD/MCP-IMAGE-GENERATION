# 🎨 Antigravity Image Studio (MCP & Web Server v2.2.0)

Serveur haute performance **Node.js** pour la génération et l'édition d'images IA haute résolution, compatible **100% avec le protocole standard MCP (Model Context Protocol)** et prêt pour intégration dans vos applications web (création de chartes graphiques, mockups de produits, branding, identités visuelles).

---

## Documentation complète

Guides pour les développeurs et l'exploitation du projet :
* [SECURITY.md](SECURITY.md) : protections, configuration distante, gestion des données et risques restants.
* [ARCHITECTURE.md](ARCHITECTURE.md) : composants et flux de génération.
* [CHANGELOG.md](CHANGELOG.md) : historique des versions et correctifs.
* [BACKLOG.md](BACKLOG.md) : feuille de route technique.

---

## 🌟 Fonctionnalités Clés (v2.2.0)

1. **Cascade Triple Moteur Intelligente :**
   * **🚀 Moteur Direct Google API (2 à 4 secondes) :** `gemini-2.5-flash-image` (mockups & images de référence) et `imagen-4.0-fast-generate-001` (texte vers image). S'active dès qu'une clé avec facturation activée est présente dans `.env`.
   * **🆓 Moteur Expérimental Direct :** `gemini-2.0-flash-preview-image-generation` / `gemini-3.1-flash-image`.
   * **🛡️ Fallback Automatique CLI Gratuit :** Si la clé ne dispose pas de facturation (`limit: 0`), le serveur le détecte en **0,4 seconde** et bascule automatiquement sur le sous-agent local `image-generator` d'Antigravity CLI (100% gratuit, sans carte bancaire).
2. **⚡ Cache Déterministe SHA-256 (2,8 ms) :**
   * Empreinte cryptographique calculée sur `prompt + style + ratio + références`.
   * Réponses quasi instantanées (< 3 ms) pour toute requête identique, éliminant les coûts et attentes répétés.
3. **🎨 13 Styles Prédéfinis (dont 6 dédiés Branding & Mockups) :**
   * **Général :** `default`, `photorealistic`, `cinematic`, `anime`, `digital_art`, `3d_render`, `minimalist`.
   * **Identité de marque & Studio :**
     * `brand_mockup` : Mockup produit photoréaliste, fond studio neutre, ombres douces.
     * `logo_brand` : Rendu identité visuelle vectorielle, typographie et grille nettes.
     * `charte_graphique` : Planche de style globale (palette, typographie, variantes de logo).
     * `ui_mockup` : Mockup d'interface sur cadre d'appareil (mobile/desktop).
     * `packaging` : Rendu 3D de packaging (textures mat/brillant/dorure).
     * `advertising` : Visuel publicitaire haute fidélité pour campagnes.
4. **📐 7 Ratios d'Aspect :**
   * `1:1` (Carré), `16:9` (Paysage), `9:16` (Story/Reels mobile), `4:3` (Standard), `3:4` (Portrait), `4:5` (Instagram portrait), `3:2` (Photo reflex).
5. **Sécurité et limites de charge :** accès distant désactivé par défaut, authentification bearer, validation Host/Origin, limites de requêtes et de fichiers. La validation du prompt ne remplace pas le sandbox CLI. Voir [SECURITY.md](SECURITY.md).
6. **Recherche d’inspiration visuelle (Web + MCP) :** recherche d’images via Brave, filtre Pinterest, lien direct de recherche Pinterest, cartes de référence et ajout d’une direction visuelle au prompt. L’API Pinterest officielle est prise en charge quand l’application a accès à sa bêta.

---

## 🚀 Démarrage Rapide

### 1. Configuration (`.env`)
Un fichier `.env` est déjà présent à la racine :
```env
PORT=3333
HOST=127.0.0.1
GEMINI_API_KEY=votre_cle_ici  # Optionnel : active le moteur direct dès facturation
GEMINI_FREE_MODEL=gemini-2.5-flash-image
CLI_TIMEOUT_MS=600000        # 10 minutes pour les rendus CLI
```

La recherche d’images dans l’interface demande une clé Brave Image Search : copiez `BRAVE_SEARCH_API_KEY` dans `.env` depuis le [tableau de bord Brave](https://api-dashboard.search.brave.com/). Brave indique que l’activation d’un plan API peut demander une carte bancaire. Pour Pinterest, l’API officielle v5 peut être configurée avec `PINTEREST_ACCESS_TOKEN`, mais l’endpoint de recherche est en bêta et n’est pas ouvert à toutes les applications. En attendant, le filtre Pinterest passe par l’index d’images Brave et le lien direct ouvre toujours Pinterest.

Les clés restent côté serveur. Le navigateur envoie le sujet et le style au serveur local, qui les transmet au fournisseur de recherche choisi. Vérifiez les droits auprès de la page source avant toute réutilisation d’image.

### 2. Démarrer le Serveur Web & API
```cmd
npm start
```
* **Interface Web de Test :** [http://localhost:3333](http://localhost:3333)
* **Santé & Moteurs Actifs :** [http://localhost:3333/health](http://localhost:3333/health)
* **Styles & Ratios :** [http://localhost:3333/api/styles](http://localhost:3333/api/styles)
* **Statistiques du Cache :** [http://localhost:3333/api/cache](http://localhost:3333/api/cache)
* **Statut des sources d’inspiration :** [http://localhost:3333/api/inspiration/status](http://localhost:3333/api/inspiration/status)

La route `POST /api/inspiration/search` accepte `query`, `style`, `source` (`web` ou `pinterest`) et `limit`. Elle renvoie des vignettes HTTPS avec des liens vers les pages sources et un lien de recherche Pinterest.

---


Si `API_TOKEN` est défini, le playground demande un jeton Bearer. Pour un usage local de confiance, saisis-le dans la console du navigateur avec `sessionStorage.setItem('apiToken', '<token>')`. Pour une application publique, appelle ce serveur depuis ton backend et garde le jeton partagé hors du code frontend. Les exigences d'accès distant sont décrites dans [SECURITY.md](SECURITY.md).

## 💻 Exemple d'Intégration Web (App de Mockups & Charte)

```javascript
async function genererMockup(prompt, style = "brand_mockup", ratio = "1:1") {
  const response = await fetch('http://localhost:3333/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: prompt,
      style: style,               // "brand_mockup", "charte_graphique", etc.
      aspect_ratio: ratio,        // "1:1", "4:5", "16:9", etc.
      include_base64: false       // Servie directement par URL HTTP
    })
  });

  const data = await response.json();
  if (data.success) {
    console.log("Image URL:", data.image_url);
    console.log("Moteur utilisé:", data.engine); // "cache-sha256", "google-..." ou "antigravity-cli"
    return data.image_url;
  } else {
    throw new Error(data.error);
  }
}
```

---

## 🔌 Utilisation comme Serveur MCP (Stdio)

Pour connecter le serveur à **Antigravity IDE**, **Cursor** ou **Claude Desktop**, ajoutez dans votre configuration MCP :

```json
{
  "mcpServers": {
    "antigravity-image-generator": {
      "command": "node",
      "args": [
        "C:\\path\\to\\antigravity-mcp-image-server\\server.js",
        "--stdio"
      ]
    }
  }
}
```

* **Outils exposés :** `generate_image` (génération) et `search_image_inspiration` (références Web / Pinterest, sujet, style, nombre de résultats).
* **Ressource `image://recent` :** Galerie des 15 dernières créations.
* **Ressource `stats://server` :** Métriques de la file d'attente et du cache.
