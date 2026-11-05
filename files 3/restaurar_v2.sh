#!/bin/bash
# ============================================================
# RESTAURACION DE LEADS - RMG Autos / FunnelOS (v2, corregido)
# Correr esto DESDE TU MAC (Terminal normal), NO desde Render Shell.
# ============================================================

# 1) Login para obtener el token de admin
TOKEN=$(curl -s -X POST https://body-elite-giftcards.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"gerente","password":"demo","tenant":"demo_automotora"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "Token obtenido: $TOKEN"

if [ -z "$TOKEN" ]; then
  echo "ERROR: no se pudo obtener el token. Revisa usuario/password."
  exit 1
fi

# 2) Restaurar los leads unificados, leyendo el body completo desde un archivo
#    (evita el limite de "Argument list too long" del shell de macOS)
curl -s -X POST https://body-elite-giftcards.onrender.com/api/admin/restore-leads \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: $TOKEN" \
  --data @restore_body.json

echo ""
echo "Listo. Revisa la respuesta arriba: deberia decir leads_antes y leads_despues=395."
