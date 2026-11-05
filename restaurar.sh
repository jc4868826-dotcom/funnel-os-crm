#!/bin/bash
# ============================================================
# RESTAURACION DE LEADS - RMG Autos / FunnelOS
# Correr esto DESDE TU MAC (Terminal normal), NO desde Render Shell.
# Requisito: el server.js parchado (con /api/admin/restore-leads)
# ya debe estar deployado en Render antes de correr este script.
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

# 2) Restaurar los leads unificados (395 leads: 389 sanos + 6 post-colapso)
curl -s -X POST https://body-elite-giftcards.onrender.com/api/admin/restore-leads \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: $TOKEN" \
  -d "{\"tenant\":\"demo_automotora\",\"leads\":$(cat leads_unificado_solo_array.json)}"

echo ""
echo "Listo. Revisa la respuesta arriba: deberia decir leads_antes y leads_despues=395."
