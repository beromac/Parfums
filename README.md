# 🧴 Mes miniatures de parfums

Application pour gérer une collection de miniatures de parfums :

- **Fiches** : nom, marque, créateur (nez), année, concentration, famille olfactive, contenance, état, notes olfactives, commentaire
- **Photos** : plusieurs photos par parfum (appareil photo ou galerie), photo principale au choix, zoom plein écran
- **Recherche** : texte libre (nom, marque, créateur, notes…, sans tenir compte des accents), filtres par **marque**, **créateur** et **famille**, tris multiples
- **Hors ligne** : fonctionne sans connexion une fois installée
- **Données privées** : tout reste sur votre appareil (IndexedDB), aucun serveur, aucun compte
- **Sauvegarde / restauration** : export et import d'un fichier JSON (photos incluses)

C'est une **PWA** (application web installable) : un seul code, qui s'installe comme une vraie application sur **Mac, iPhone, iPad et Android**.

---

## 1. Mettre l'application en ligne avec GitHub Pages

1. Créez un compte sur <https://github.com> si besoin.
2. Cliquez sur **New repository**, nommez-le par exemple `miniatures-parfums`, laissez-le **Public** (nécessaire pour Pages gratuit), puis **Create repository**.
3. Sur la page du dépôt vide : **uploading an existing file**, glissez-déposez **tout le contenu** du dossier (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, le dossier `icons`, `README.md`), puis **Commit changes**.
4. Allez dans **Settings → Pages**. Sous *Build and deployment*, choisissez **Deploy from a branch**, branche **main**, dossier **/ (root)**, puis **Save**.
5. Après 1 à 2 minutes, votre application est disponible à l'adresse :
   `https://VOTRE-NOM.github.io/miniatures-parfums/`

> Votre collection n'est **pas** publiée sur GitHub : seul le code de l'application l'est. Vos parfums et photos restent dans le navigateur de chaque appareil.

---

## 2. Installer l'application

| Appareil | Comment faire |
|---|---|
| **iPhone / iPad** (Safari) | Bouton **Partager** → **Sur l'écran d'accueil** |
| **Android** (Chrome) | Menu ⋮ → **Installer l'application** (ou **Ajouter à l'écran d'accueil**) |
| **Mac** (Safari 17+) | Menu **Fichier → Ajouter au Dock** |
| **Mac / PC** (Chrome, Edge) | Icône d'installation dans la barre d'adresse |

---

## 3. Bon à savoir

- **Chaque appareil a sa propre collection.** Pour la transférer (Mac ↔ téléphone par exemple) : menu **⋯ → Sauvegarder**, envoyez le fichier `.json` (AirDrop, mail…), puis **⋯ → Restaurer** sur l'autre appareil. Importer ne supprime rien : les fiches de même identifiant sont mises à jour, les autres ajoutées.
- **Faites une sauvegarde de temps en temps.** Si vous videz les données du navigateur ou désinstallez l'application, la collection locale est perdue.
- Sur iPhone, ouvrez et utilisez toujours l'application **depuis l'icône installée** : Safari et l'application installée ont des stockages séparés.
- Les photos sont automatiquement réduites (1280 px max) pour économiser de l'espace.

---

## 4. Tester sur son ordinateur

```bash
cd miniatures-parfums
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

(Le mode hors ligne et l'installation nécessitent `https://` ou `localhost`.)

## 5. Modifier l'application

Le code est volontairement simple, sans dépendance ni outil de compilation :

| Fichier | Rôle |
|---|---|
| `index.html` | Structure des écrans |
| `styles.css` | Apparence (thème clair/sombre automatique) |
| `app.js` | Logique : base locale, recherche, photos, sauvegarde |
| `sw.js` | Mode hors ligne (pensez à changer `CACHE` après une grosse mise à jour) |
| `manifest.webmanifest` | Nom et icônes de l'application installée |

Les listes de concentrations, familles olfactives et états se modifient en haut de `app.js`.
