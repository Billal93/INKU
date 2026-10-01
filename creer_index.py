import argparse
import json
import os
import re
import time
import unicodedata

import requests

# --- CONFIG ---
# Le token et le salon Discord ne doivent JAMAIS être écrits en clair ici :
# ce script est versionné dans un dépôt public. Définis-les avant de lancer
# le script, par exemple (PowerShell) :
#   $env:DISCORD_TOKEN = "..."
#   $env:DISCORD_CHANNEL_ID = "..."
#   python creer_index.py
TOKEN = os.environ.get("DISCORD_TOKEN")
CHANNEL_ID = os.environ.get("DISCORD_CHANNEL_ID")

# Chemin relatif au script, pour fonctionner sur n'importe quelle machine.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_PATH = os.path.join(BASE_DIR, "assets", "copyrights")
JSON_PATH = os.path.join(BASE_DIR, "assets", "logos.json")
JS_PATH = os.path.join(BASE_DIR, "assets", "logos.js")

REQUEST_TIMEOUT = 15  # secondes
# Les PNG/JPEG/WEBP commencent par ces octets ; ça suffit à écarter une
# page d'erreur HTML ou un fichier vide téléchargé sous le nom "*.png".
IMAGE_MAGIC_BYTES = (
    b"\x89PNG\r\n\x1a\n",  # PNG
    b"\xff\xd8\xff",         # JPEG
    b"RIFF",                 # WEBP (conteneur RIFF)
)


def clean_text(text):
    """Enlève les accents et caractères spéciaux pour les noms de fichiers."""
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "_", text.lower()).strip("_")


def looks_like_image(data):
    return any(data.startswith(magic) for magic in IMAGE_MAGIC_BYTES)


def fetch_all_logos(dry_run=False):
    if not TOKEN or not CHANNEL_ID:
        print("Erreur : DISCORD_TOKEN et DISCORD_CHANNEL_ID doivent être définis "
              "comme variables d'environnement. Rien n'a été modifié.")
        return

    if not os.path.exists(ASSETS_PATH):
        if dry_run:
            print(f"[dry-run] créerait le dossier {ASSETS_PATH}")
        else:
            os.makedirs(ASSETS_PATH)

    print("Récupération depuis Discord...")
    headers = {"Authorization": f"Bot {TOKEN}"}
    discovered_names = []
    last_id = None
    any_success = False

    while True:
        url = f"https://discord.com/api/v9/channels/{CHANNEL_ID}/messages?limit=100"
        if last_id:
            url += f"&before={last_id}"

        try:
            res = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as e:
            print(f"Erreur réseau pendant la récupération des messages : {e}")
            break

        if res.status_code == 429:
            retry_after = float(res.headers.get("Retry-After", "1"))
            print(f"Rate limit Discord (429) : attente de {retry_after:.1f}s...")
            time.sleep(retry_after)
            continue

        if res.status_code == 401 or res.status_code == 403:
            print(f"Erreur d'authentification Discord ({res.status_code}) : "
                  "le token est invalide, expiré ou n'a pas accès au salon. "
                  "Rien n'a été modifié.")
            return

        if res.status_code != 200:
            print(f"Erreur Discord (statut {res.status_code}). Arrêt sans "
                  "modifier les fichiers existants.")
            break

        try:
            messages = res.json()
        except ValueError:
            print("Réponse Discord illisible (pas du JSON). Arrêt.")
            break

        if not messages:
            break

        any_success = True

        for msg in messages:
            content = msg.get("content", "")

            for att in msg.get("attachments", []):
                content_type = att.get("content_type", "")
                if not any(t in content_type for t in ("image/png", "image/jpeg", "image/webp")):
                    continue

                raw_name = content.split(":")[0].strip() if ":" in content else att["filename"].rsplit(".", 1)[0]
                clean_name = clean_text(raw_name)
                if not clean_name:
                    continue

                ext = os.path.splitext(att["filename"])[1].lower() or ".png"
                file_path = os.path.join(ASSETS_PATH, f"{clean_name}{ext}")

                if clean_name not in discovered_names:
                    discovered_names.append(clean_name)

                if os.path.exists(file_path):
                    print(f"[SKIP] {clean_name}")
                    continue

                if dry_run:
                    print(f"[dry-run NEW] {clean_name}")
                    continue

                try:
                    img_res = requests.get(att["url"], timeout=REQUEST_TIMEOUT)
                except requests.RequestException as e:
                    print(f"[ERREUR] téléchargement de {clean_name} échoué : {e}")
                    continue

                if img_res.status_code != 200:
                    print(f"[ERREUR] {clean_name} : statut HTTP {img_res.status_code} au téléchargement")
                    continue

                img_data = img_res.content
                if not looks_like_image(img_data):
                    print(f"[ERREUR] {clean_name} : le contenu téléchargé ne ressemble pas à une image, ignoré")
                    continue

                with open(file_path, "wb") as f:
                    f.write(img_data)
                print(f"[NEW ] {clean_name}")

            last_id = msg["id"]

    if not any_success:
        print("Aucune donnée récupérée depuis Discord. logos.json/logos.js "
              "conservés tels quels.")
        return

    if not discovered_names:
        print("0 logo trouvé dans les messages récupérés. Pour éviter de vider "
              "la base, logos.json/logos.js ne sont pas modifiés.")
        return

    existing_names = []
    if os.path.exists(JSON_PATH):
        try:
            with open(JSON_PATH, "r", encoding="utf-8") as f:
                existing_names = json.load(f)
        except (ValueError, OSError):
            print("logos.json existant illisible, il sera recréé à partir des "
                  "résultats de cette exécution.")

    merged_names = list(existing_names)
    for name in discovered_names:
        if name not in merged_names:
            merged_names.append(name)

    if dry_run:
        new_count = len(merged_names) - len(existing_names)
        print(f"[dry-run] logos.json/logos.js resteraient inchangés sur disque "
              f"({new_count} nouveau(x) logo(s) auraient été ajoutés, total {len(merged_names)}).")
        return

    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(merged_names, f, indent=2, ensure_ascii=False)

    with open(JS_PATH, "w", encoding="utf-8") as f:
        f.write(f"window.LOGO_DB = {json.dumps(merged_names, ensure_ascii=False)};")

    print("\n" + "=" * 40)
    print(f"Terminé : {len(merged_names)} logos au total "
          f"({len(merged_names) - len(existing_names)} nouveau(x)).")
    print("=" * 40)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Synchronise les logos depuis Discord.")
    parser.add_argument("--dry-run", action="store_true",
                         help="N'écrit aucun fichier, affiche seulement ce qui serait fait.")
    args = parser.parse_args()
    fetch_all_logos(dry_run=args.dry_run)
