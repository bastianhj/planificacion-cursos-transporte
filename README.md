# Planificación de Cursos — Transporte UChile

Aplicación web estática (HTML/CSS/JS, sin backend) para revisar la oferta de cursos de la
línea de Transporte del Departamento de Ingeniería Civil (U. de Chile), detectar choques de
horario con el resto de la Facultad y ver la carga docente. Pensada para publicarse con
**GitHub Pages**.

Sitio en vivo (una vez publicado): `https://<tu-usuario>.github.io/<nombre-del-repo>/`

## ¿Qué incluye?

- `index.html`, `app.js`, `styles.css` — la aplicación.
- `data.js` — los datos "de fábrica" (generados la última vez que se corrió el script de
  conversión). La app arranca siempre con estos datos.
- `data/Maestro_Cursos_Transporte.xlsx` — el archivo maestro consolidado (mismo que se generó
  junto a esta app), con las hojas `Oferta_2025`, `Oferta_2026`, `Oferta_2027`,
  `Malla_completa`, `Carga_docente_2027`, `Chequeo_consistencia` y `Catalogo_metadata`.
- `data/Catalogo_metadata.xlsx` — RUT, correo, nombre completo, sección, cupos y requisitos
  de cada curso/sección de Transporte, para el botón **"Descargar catálogo oficial (.xlsx)"**
  de la pestaña "Horario y choques" (exporta un Excel con la misma estructura exacta que la
  planilla "Formato Catálogo" de la Facultad). El horario de cada curso se calcula siempre en
  vivo desde `Oferta_2027`/la grilla, nunca desde esta planilla — acá solo se guardan los datos
  que no existen en el resto del modelo (RUT, correo, cupos, requisitos). Editar esta hoja y
  volver a correr `build_master.py` (con `--catalogo-metadata`) para que los cambios lleguen a
  la app.
- `scripts/build_master.py` + `scripts/common.py` — el script de Python que lee las 3
  planillas originales (`Cursos_v2.xlsx`, `Cursos_transporte_2025-2026.xlsx`,
  `Carga Docente.xlsx`) y opcionalmente `Catalogo_metadata.xlsx` (`--catalogo-metadata`), hace
  el chequeo de consistencia, arma el archivo maestro y genera `data.js`.
- `vendor/xlsx.full.min.js` — librería [SheetJS](https://sheetjs.com/) (MIT license) usada
  para leer archivos `.xlsx` directamente en el navegador, sin subirlos a ningún servidor.

## Cómo actualizar los datos

Tienes dos formas de refrescar la aplicación cuando cambien tus planillas:

### Opción A — sin tocar código (recomendada en el día a día)

1. Actualiza tus 3 planillas de siempre (`Cursos_v2.xlsx`, `Cursos_transporte_2025-2026.xlsx`,
   `Carga Docente.xlsx`).
2. Corre `scripts/build_master.py` (ver abajo) para generar un nuevo
   `Maestro_Cursos_Transporte.xlsx`.
3. Abre la aplicación (local o ya publicada) → pestaña **"Cargar datos"** → sube ese archivo
   `.xlsx`. Todo se recalcula en el navegador y se guarda localmente en ese navegador hasta
   que lo reemplaces o pulses "Restaurar datos originales".

Esto NO cambia los archivos del repositorio — es sólo para tu sesión de navegador.

### Opción B — dejar los nuevos datos "de fábrica" en el sitio publicado

Si quieres que el sitio público siempre arranque con los datos más recientes (sin que cada
visitante tenga que subir el archivo):

```bash
cd scripts
python3 build_master.py \
  --cursos-v2 "/ruta/a/Cursos_v2.xlsx" \
  --cursos-transporte "/ruta/a/Cursos_transporte_2025-2026.xlsx" \
  --carga-docente "/ruta/a/Carga Docente.xlsx"
```

Esto regenera `../data.js` y `../data/Maestro_Cursos_Transporte.xlsx`. Requiere Python 3 con
`openpyxl` instalado (`pip install openpyxl`). Luego sube los cambios a GitHub (ver abajo) para
que el sitio publicado quede actualizado.

Si no pasas argumentos, el script asume que corre desde una carpeta "Oferta cursos" con
`Cursos_v2.xlsx` y `Cursos_transporte_2025-2026.xlsx` al lado, y `Carga Docente.xlsx` un nivel
más arriba (la misma estructura de carpetas que usas hoy en OneDrive).

## Corregir los hallazgos del chequeo de consistencia

En la pestaña **"Consistencia"** cada hallazgo tiene una columna **"Instrucción de
corrección"**: un cuadro de texto donde puedes escribir, en tu propio lenguaje, cómo
corregirlo (por ejemplo: *"el código correcto es CI5310, no CI5243"* o *"agregar a Ricardo de
la Paz como profesor en Carga Docente"*). Lo que escribas se guarda automáticamente en ese
navegador mientras sigues trabajando.

Cuando termines de anotar instrucciones:

1. Pulsa **"Descargar instrucciones (.json)"** → se descarga `instrucciones_correccion.json`
   con solo las filas que tengan texto.
2. Pásale ese archivo a Claude junto con tus 3 planillas originales (`Cursos_v2.xlsx`,
   `Cursos_transporte_2025-2026.xlsx`, `Carga Docente.xlsx`) y pídele que aplique los cambios.
   Claude puede leer el JSON y editar directamente las planillas según lo que escribiste.
3. El botón **"Cargar instrucciones (.json)"** sirve para volver a importar ese mismo archivo
   más adelante (por ejemplo si cambias de computador o se borra el navegador) y seguir
   editando donde quedaste.

Si prefieres escribir las instrucciones directamente en Excel en vez de en la app: la hoja
`Chequeo_consistencia` del archivo maestro también tiene las columnas `ID` e `Instrucción de
corrección` (resaltada en amarillo) — llénala ahí y entrégale ese `.xlsx` a Claude.

Las instrucciones no se pierden al regenerar el archivo maestro: pásale al script la bandera
`--instrucciones` apuntando al `instrucciones_correccion.json` exportado desde la app (o a un
`Maestro_Cursos_Transporte.xlsx` anterior ya editado a mano) y el nuevo archivo las vuelve a
incluir, enlazadas por el `ID` interno de cada hallazgo:

```bash
python3 build_master.py \
  --cursos-v2 "/ruta/a/Cursos_v2.xlsx" \
  --cursos-transporte "/ruta/a/Cursos_transporte_2025-2026.xlsx" \
  --carga-docente "/ruta/a/Carga Docente.xlsx" \
  --instrucciones "/ruta/a/instrucciones_correccion.json"
```

## Mover cursos en la grilla de horario

En la pestaña **"Horario y choques"** los bloques de cada curso se pueden **arrastrar y
soltar** en otra celda día × período para probar un horario distinto. Al arrastrar un bloque:

- Cambia de inmediato a la celda donde lo sueltes, y la app recalcula los choques en el acto.
- Queda marcado con un contorno punteado naranjo (*"movido manualmente"*) para que no se te
  olvide qué cambiaste.
- El cambio se guarda en este navegador (sobrevive a recargar la página) y se mantiene aparte
  de los datos cargados, igual que las instrucciones de corrección.

Para distinguir de un vistazo cátedras de auxiliares, las cátedras se pintan con un color
sólido y las auxiliares con un tono más transparente/liviano (ver la leyenda bajo la grilla).

Herramientas junto a la grilla:

- **"Descargar cambios de horario (.json)"** — descarga `cambios_horario.json` con el detalle
  de cada curso movido (antes → después). Pásaselo a Claude junto con tus planillas originales
  para que aplique esos cambios de horario en `Cursos_v2.xlsx` / `Cursos_transporte_2025-2026.xlsx`.
- **"Restablecer horario original"** — deshace todos los movimientos y vuelve a mostrar los
  horarios tal como están en los datos cargados.

Mover un curso en la app **no modifica ninguna planilla**: es solo una vista para explorar
alternativas en el navegador. Para que el cambio quede permanente en los archivos de origen,
descarga el `.json` de cambios y pídeselo a Claude.

## Publicar o actualizar el sitio en GitHub Pages

**La primera vez** (crear el sitio):

1. Entra a [github.com](https://github.com) e inicia sesión (o crea una cuenta gratuita).
2. Crea un repositorio nuevo, público, por ejemplo `oferta-cursos-transporte` (botón verde
   "New" en tu página de repositorios). No marques ninguna casilla de inicialización.
3. En la página del repositorio recién creado, usa **"uploading an existing file"** (o
   "Add file → Upload files") y arrastra TODO el contenido de esta carpeta (no la carpeta
   misma, sino los archivos y subcarpetas `index.html`, `app.js`, `styles.css`, `data.js`,
   `data/`, `scripts/`, `vendor/`, `.nojekyll`, `README.md`). Confirma el commit.
4. Ve a **Settings → Pages**. En "Source" elige la rama `main` y la carpeta `/ (root)`, y
   guarda.
5. En 1–2 minutos GitHub te mostrará la URL pública (algo como
   `https://tu-usuario.github.io/oferta-cursos-transporte/`).

**Para actualizar** el sitio más adelante: vuelve al repositorio, entra a los archivos que
cambiaron (por ejemplo `data.js` y `data/Maestro_Cursos_Transporte.xlsx`) y usa el lápiz de
edición o "Add file → Upload files" de nuevo para reemplazarlos. GitHub Pages se actualiza
solo, normalmente en menos de un minuto.

Si prefieres usar `git`/`gh` desde tu computador en vez de la interfaz web, estos son los
comandos equivalentes (requiere tener git instalado y sesión iniciada en GitHub):

```bash
cd <esta-carpeta>
git init
git add .
git commit -m "Primera versión del sitio"
git branch -M main
git remote add origin https://github.com/<tu-usuario>/oferta-cursos-transporte.git
git push -u origin main
```

Y luego habilitar Pages igual que en el paso 4 de arriba (o con `gh repo edit --enable-pages`
si usas la CLI de GitHub).

## Privacidad

Todo el procesamiento (lectura de Excel, chequeo de choques, cálculo de carga docente) ocurre
en el navegador del usuario. Nada se envía a un servidor externo — el sitio es 100% estático.
