import sys

path = 'public/index.html'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

OLD = 'window.function preseleccionarRango(){'
NEW = 'window.preseleccionarRango = function preseleccionarRango(){'

if OLD not in content:
    print("ERROR: Anchor no encontrado. Ya fue aplicado o el archivo cambio.")
    sys.exit(1)

content = content.replace(OLD, NEW, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("OK: Corregido window.function -> window.preseleccionarRango = function")
print("Botones Guardar y Solicitar Tasacion ya funcionaran correctamente.")
