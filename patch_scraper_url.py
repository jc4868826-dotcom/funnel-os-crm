#!/usr/bin/env python3
import sys

FILE = 'server.js'

PATCHES = [
    {
        'desc': 'URL del scraper: /usados/ → /',
        'old': "const RMG_SCRAPE_URL = 'https://rmgautos.cl/usados/';",
        'new': "const RMG_SCRAPE_URL = 'https://rmgautos.cl/';",
    },
    {
        'desc': 'cardLink fallback: /usados/ → /',
        'old': "const cardLink   = linkMap[autoIdx] || 'https://rmgautos.cl/usados/';",
        'new': "const cardLink   = linkMap[autoIdx] || 'https://rmgautos.cl/';",
    },
]

with open(FILE, 'r', encoding='utf-8') as f:
    src = f.read()

for p in PATCHES:
    count = src.count(p['old'])
    if count == 0:
        print(f"ANCHOR NOT FOUND: {p['desc']}")
        print(f"Buscando: {p['old']}")
        sys.exit(1)
    if count > 1:
        print(f"ANCHOR AMBIGUO ({count} matches): {p['desc']}")
        sys.exit(1)
    src = src.replace(p['old'], p['new'], 1)
    print(f"OK: {p['desc']}")

with open(FILE, 'w', encoding='utf-8') as f:
    f.write(src)

print("Patch aplicado.")
