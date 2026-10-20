# Sécurité et exploitation

Ce document décrit les protections du serveur, la configuration à appliquer avant une exposition réseau et les risques qui restent à traiter au niveau du déploiement.

## Configuration par défaut

- Le serveur HTTP écoute sur `127.0.0.1:3333`. Il n'est pas accessible depuis le réseau tant que `HOST` n'est pas changé.
- `PUBLIC_BASE_URL` doit être une origine HTTP(S) exacte, sans chemin, identifiants ni paramètres. Sur une machine locale, elle doit aussi pointer vers la boucle locale.
- Si `API_TOKEN` est défini, il doit contenir au moins 32 caractères. Les routes `/api/*`, `/images/*` et `/health` exigent `Authorization: Bearer <token>`.
- Les en-têtes `Host` et `Origin` sont vérifiés. Les origines CORS doivent être listées explicitement ; `*` est refusé.
- Les routes d'images n'acceptent que des noms générés, des fichiers réguliers dans le stockage, une taille maximale de 25 Mo et une signature JPEG, PNG ou WebP cohérente avec l'extension.
- La galerie charge des miniatures WebP de 96 × 96 pixels depuis une route authentifiée. La récupération des images et miniatures est limitée à quatre transferts simultanés par processus.
- Les fichiers SVG ne sont pas acceptés et le chargeur SVG de Sharp est désactivé ; les entrées raster sont utilisées pour les miniatures et le compositing.
- L'API limite les requêtes par adresse IP et borne les corps JSON. Les limites précises sont dans la section « Limites de charge ».

## Exposer le serveur sur un réseau

L'exposition distante est refusée sans configuration explicite. Pour l'activer, configure dans `.env` :

```env
HOST=0.0.0.0
ALLOW_REMOTE_ACCESS=true
API_TOKEN=<secret aléatoire de 32 octets minimum>
ALLOWED_HOSTS=api.example.com
CORS_ORIGIN=https://app.example.com
PUBLIC_BASE_URL=https://api.example.com
```

Pour un port public non standard, indique-le dans `ALLOWED_HOSTS`, par exemple `api.example.com:8443`. Configure le reverse proxy pour préserver le `Host` public, terminer TLS, limiter la taille et le débit des requêtes, et empêcher l'accès direct au port Node depuis Internet. Le serveur Node ne fournit pas lui-même TLS.

Un reverse proxy peut transmettre les requêtes à `HOST=127.0.0.1`. Dans ce cas, conserve les mêmes contrôles distants et indique tout de même l'origine HTTPS publique dans `PUBLIC_BASE_URL` ; l'application détecte cette configuration et exige l'authentification.

Le jeton est partagé par tous les clients. Toute personne qui le possède peut générer des images, accéder aux images enregistrées et vider l'index du cache. Ne place pas le jeton dans une application Web publique. Pour plusieurs utilisateurs, place une API authentifiée et limitée par utilisateur devant ce serveur.

Le playground prend un jeton de session depuis `sessionStorage` : dans la console du navigateur, utilise `sessionStorage.setItem('apiToken', '<token>')`. Cette méthode convient à un usage local de confiance ; elle ne remplace pas une authentification de production.

## Exécution Antigravity CLI

- Chaque génération CLI utilise un sous-répertoire temporaire unique avec des droits privés. Le CLI reçoit seulement ce répertoire comme répertoire de travail et dossier additionnel.
- Les images de référence sont copiées dans ce sous-répertoire. Le dossier du projet et ses fichiers ne sont pas ajoutés à l'espace de travail du sous-agent.
- Le processus est lancé sans shell et avec une liste réduite de variables d'environnement ; les clés API du serveur ne lui sont pas transmises.
- Le mode sandbox est activé par défaut. `AGY_SANDBOX=false` et `AGY_SKIP_PERMISSIONS=true` sont des dérogations locales à risque ; le démarrage en mode HTTP distant les refuse.
- Seuls les fichiers image pris en charge, de taille maximale 25 Mo et trouvés dans l'espace temporaire de la requête sont acceptés. Le dossier temporaire est supprimé après traitement.

Sur POSIX, les répertoires sont limités au propriétaire (`0700`) et les fichiers générés au propriétaire (`0600`). Sous Windows, ces bits ne remplacent pas les ACL NTFS : le dossier temporaire et `STORAGE_DIR` doivent rester dans un emplacement dont les ACL limitent l'accès au compte du serveur.

Le prompt et les images restent des données non fiables. Les instructions de prompt demandent au CLI de ne pas suivre des consignes cachées dans ces données, mais ce texte n'est pas une frontière de sécurité. Le sandbox et les permissions du CLI restent les contrôles effectifs ; ne désactive pas ces protections pour un serveur accessible à distance.

## Limites de charge et stockage

- Prompt : 2 000 caractères à l'entrée HTTP/MCP ; le générateur applique ensuite sa propre normalisation.
- Références : 3 maximum, 8 Mo chacune ; formats acceptés : JPEG, PNG et WebP. Le playground vérifie également le type et la taille avant lecture.
- Corps JSON : 35 Mo pour la génération, 1 Mo pour les autres routes.
- Sortie image : 25 Mo ; base64 intégré : 8 Mo. Les images plus grandes restent accessibles par l'URL d'image authentifiée ou le lien de ressource MCP.
- Réponses Google et Brave/Pinterest : limites de lecture pour éviter de consommer une mémoire non bornée.
- Débit par IP et par processus : API générale 120/minute, génération 10/minute, inspiration 12/minute, images 120/minute. Le registre est plafonné à 5 000 entrées.
- Admission simultanée : 4 corps de génération HTTP, 4 recherches d'inspiration au total et 8 appels de génération au total par processus. Les plafonds globaux couvrent HTTP et MCP.
- La réservation de stockage parcourt au plus 50 000 entrées ; au-delà, elle bloque les nouvelles générations. La galerie examine au plus 10 000 entrées et renvoie au maximum 80 images.
- Stockage : `MAX_STORAGE_MB` vaut 2 048 Mo par défaut. Une nouvelle image est refusée lorsque le quota est atteint ; aucune image ancienne n'est supprimée automatiquement.

Les limites de débit sont en mémoire et ne sont pas distribuées entre plusieurs processus. Le serveur ne fait pas confiance à `X-Forwarded-For` : derrière un proxy, les clients peuvent donc partager l'adresse IP du proxy pour ces limites. Configure une limitation de débit au reverse proxy ou dans une passerelle si plusieurs instances ou utilisateurs sont concernés. La réservation de quota disque est locale au processus ; plusieurs processus partageant le même `STORAGE_DIR` peuvent dépasser légèrement le quota lors d'écritures simultanées.

## Données et services externes

- Les requêtes de génération ne sont pas consignées avec leur prompt dans les journaux HTTP. Les prompts normalisés sont toutefois conservés dans l'index local du cache et exposés à l'hôte MCP local via `image://recent`.
- L'API HTTP ne renvoie pas de chemin absolu de fichier. Le protocole MCP local fournit le chemin du fichier au client MCP, ce qui est nécessaire à son usage local.
- Les images générées persistent dans `STORAGE_DIR` jusqu'à leur suppression manuelle. Le quota bloque les nouvelles écritures mais n'efface pas les anciennes images.
- Une recherche d'inspiration transmet le sujet et le style au fournisseur configuré (Brave ou Pinterest). Les vignettes sont chargées directement depuis les sites sources par le navigateur ; leurs pages s'ouvrent sur des domaines tiers. Vérifie les droits avant toute réutilisation.
- Les appels aux fournisseurs refusent les redirections HTTP afin de ne pas transmettre les clés API à un hôte de redirection.
- Les clés Google, Brave et Pinterest doivent rester dans l'environnement du serveur. Ne les ajoute ni au code du navigateur, ni à `README.md`, ni à un dépôt.
- `lib/composer.js` n'est pas exposé par HTTP ni enregistré comme outil MCP. Ses fonctions prennent des chemins de fichiers fournis par l'appelant ; ne les relie pas à un outil recevant des chemins non fiables sans ajouter une liste d'accès dédiée.

## Protections à ne pas confondre

La validation du prompt réduit les entrées inattendues, mais ne neutralise pas à elle seule l'injection de prompt. Le jeton partagé n'apporte ni comptes utilisateurs ni quotas individuels. Les limites mémoire par IP ne remplacent pas un contrôle de débit distribué. L'authentification et CORS ne chiffrent pas le trafic : toute exposition distante doit passer par HTTPS.

Les fichiers `.env`, les autres `.env.*` et le dossier `generated_images/` sont ignorés par Git ; `.env.example` est explicitement conservé. `mcp_config.json`, qui contient un chemin local propre à la machine, est lui aussi ignoré. En cas de fuite d'une clé ou du jeton, révoque-le chez le fournisseur et remplace-le dans l'environnement du serveur.

`npm audit` a contrôlé 127 dépendances le 20 octobre 2026 et signalé zéro vulnérabilité. La version précédente de `sharp` était concernée par un avis de sécurité lié au chargeur SVG ; `sharp` a été mis à jour vers la version corrigée 0.35.5 et ce chargeur est aussi bloqué dans l'application ([avis du mainteneur](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)). Relance `npm audit` lors des mises à jour, car l'état des avis évolue.
