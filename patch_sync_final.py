#!/usr/bin/env python3
"""
patch_sync_final.py — FunnelOS CRM
Saca el botón Sync RMG del <nav> para que no se active como vista.
Lo mueve debajo del nav, fuera del sistema de navegación.
Ejecutar desde: ~/Desktop/negocio sistemas/
"""
import sys, os, subprocess

BASE  = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(BASE, 'public', 'index.html')
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

print('\n[index.html]')

# 1. Quitar el botón del interior del <nav>
OLD1 = '<button id="btnSyncInv" style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:8px;padding:7px 13px;font-size:12px;font-weight:700;cursor:pointer;margin-left:4px" onclick="syncInventario()">🔄 Sync RMG</button>'
NEW1 = ''
patch_file(INDEX, 'quitar-sync-del-nav', OLD1, NEW1)

# 2. Insertarlo después del </nav>, antes del btnInstallApp
OLD2 = '<button id="btnInstallApp"'
NEW2 = '<button onclick="syncInventario()" style="margin-top:6px;width:100%;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:8px;padding:8px 13px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit" id="btnSyncInv">🔄 Sync RMG</button>\n<button id="btnInstallApp"'
patch_file(INDEX, 'insertar-sync-fuera-nav', OLD2, NEW2)

print()
if errors:
    print('ERRORES:')
    for e in errors: print(' ', e)
    sys.exit(1)

print('Listo. Ejecuta:')
print("  git add public/index.html && git commit -m 'fix: mover btn Sync RMG fuera del nav' && git push")
