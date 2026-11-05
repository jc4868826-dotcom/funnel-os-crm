#!/usr/bin/env python3
"""
patch_link_fix.py — FunnelOS CRM
Corrige desalineacion de links en scraper: cada auto tiene 2 links en HTML
(imagen + titulo), por eso hay que usar autoIdx*2 en vez de autoIdx.
Ejecutar desde: ~/Desktop/negocio sistemas/
"""
import sys, os, subprocess

BASE   = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(BASE, 'server.js')
errors = []

def patch_file(path, name, old, new):
    with open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    if old not in src:
        errors.append(f'[X] [{name}] anchor NO encontrado en {os.path.basename(path)}')
        return
    src = src.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'[OK] [{name}]')

print('\n[server.js]')

# Cada auto aparece 2 veces en el HTML (imagen + titulo)
# Por eso linkMap tiene 66 entradas para 33 autos
# El indice correcto es autoIdx*2
OLD = "      const cardLink   = linkMap[autoIdx] || 'https://rmgautos.cl/usados/';"
NEW = "      const cardLink   = linkMap[autoIdx * 2] || 'https://rmgautos.cl/usados/'; // *2: cada auto tiene 2 hrefs en HTML (imagen+titulo)"

patch_file(SERVER, 'fix-link-desalineacion', OLD, NEW)

print()
if errors:
    print('ERRORES:')
    for e in errors: print(' ', e)
    sys.exit(1)

print('Verificando sintaxis node...')
r = subprocess.run(['node', '--check', 'server.js'], cwd=BASE, capture_output=True, text=True)
if r.returncode != 0:
    print('[X] Error sintaxis:')
    print(r.stderr)
    sys.exit(1)

print('\nListo. Ejecuta:')
print("  git add server.js && git commit -m 'fix: links scraper desalineados, cada auto tiene 2 hrefs en HTML' && git push")
