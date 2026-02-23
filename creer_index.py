import os, requests, json, re

# --- CONFIG ---
TOKEN = "MTM1NjYwNDkxOTI2NzcyNTM0Mg.GVy9SA.NBEUcOQmxASTxUaDD7ijGv1izSOGnC89EczGOY"
CHANNEL_ID = "1356600989355868280"
BASE_DIR = r"C:\Users\benna\Documents\Sites\INKU"
ASSETS_PATH = os.path.join(BASE_DIR, "assets", "copyrights")
JSON_PATH = os.path.join(BASE_DIR, "assets", "logos.json")

if not os.path.exists(ASSETS_PATH): os.makedirs(ASSETS_PATH)

def clean_text(text):
    """ Enlève les accents et caractères spéciaux pour les noms de fichiers """
    import unicodedata
    text = unicodedata.normalize('NFD', text)
    text = "".join([c for c in text if unicodedata.category(c) != 'Mn'])
    return re.sub(r'[^a-z0-9]', '_', text.lower()).strip('_')

def fetch_all_logos():
    print("🚀 Recupération massive (UTF-8)...")
    headers = {"Authorization": f"Bot {TOKEN}"}
    logo_names = []
    last_id = None
    
    while True:
        url = f"https://discord.com/api/v9/channels/{CHANNEL_ID}/messages?limit=100"
        if last_id: url += f"&before={last_id}"
        
        res = requests.get(url, headers=headers)
        if res.status_code != 200: break
        
        messages = res.json()
        if not messages: break 

        for msg in messages:
            # On force le contenu en UTF-8 pour éviter les crashs de lecture
            content = msg.get("content", "")
            
            for att in msg.get("attachments", []):
                if "image/png" in att.get("content_type", ""):
                    # Extraction du nom avant le ":"
                    raw_name = content.split(":")[0].strip() if ":" in content else att["filename"].replace(".png", "")
                    
                    # Nettoyage strict (enlève les accents pour le nom du fichier)
                    clean_name = clean_text(raw_name)
                    
                    file_path = os.path.join(ASSETS_PATH, f"{clean_name}.png")
                    
                    if not os.path.exists(file_path):
                        img_data = requests.get(att["url"]).content
                        with open(file_path, 'wb') as f: f.write(img_data)
                        status = "NEW "
                    else:
                        status = "SKIP"

                    if clean_name not in logo_names:
                        logo_names.append(clean_name)
                    
                    # Log propre sans crash
                    try:
                        print(f"[{status}] {clean_name}")
                    except:
                        print(f"[{status}] (nom avec caracteres speciaux)")

            last_id = msg["id"]

    # Sauvegarde JSON forcée en UTF-8
    with open(JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(logo_names, f, indent=2, ensure_ascii=False)

    # Sauvegarde JS pour contourner CORS en local
    js_path = os.path.join(BASE_DIR, "assets", "logos.js")
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(f"window.LOGO_DB = {json.dumps(logo_names, ensure_ascii=False)};")

    print("\n" + "="*40)
    print(f"✨ TERMINE : {len(logo_names)} logos uniques.")
    print("="*40)

if __name__ == "__main__":
    fetch_all_logos()