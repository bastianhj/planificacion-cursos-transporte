import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: F401,F403 (rutas por defecto, funciones de parseo)
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.comments import Comment
import openpyxl

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))  # .../site

parser = argparse.ArgumentParser(description="Genera Maestro_Cursos_Transporte.xlsx y data.js para la app web a partir de las 3 planillas originales.")
parser.add_argument("--cursos-v2", default=CV2_PATH, help="Ruta a Cursos_v2.xlsx")
parser.add_argument("--cursos-transporte", default=CT_PATH, help="Ruta a Cursos_transporte_2025-2026.xlsx")
parser.add_argument("--carga-docente", default=CD_PATH, help="Ruta a Carga Docente.xlsx")
parser.add_argument("--out-xlsx", default=os.path.join(REPO_ROOT, "data", "Maestro_Cursos_Transporte.xlsx"), help="Ruta de salida del archivo maestro .xlsx")
parser.add_argument("--out-datajs", default=os.path.join(REPO_ROOT, "data.js"), help="Ruta de salida de data.js (datos para la app web)")
parser.add_argument("--catalogo-metadata", default=None,
                     help="Ruta a Catalogo_metadata.xlsx (RUT/correo/cupos/requisitos para el export del catálogo "
                          "oficial). Si no se indica, el export de catálogo en la app no tendrá estos datos.")
parser.add_argument("--instrucciones", default=None,
                     help="Ruta a un archivo previo con instrucciones de corrección ya ingresadas por el usuario "
                          "(instrucciones_correccion.json exportado desde la app, o un Maestro_Cursos_Transporte.xlsx "
                          "anterior editado a mano). Si se indica, esas instrucciones se vuelven a incluir en la "
                          "nueva hoja Chequeo_consistencia y en data.js, enlazadas por el ID estable del hallazgo.")
ARGS = parser.parse_args()

CV2_PATH, CT_PATH, CD_PATH = ARGS.cursos_v2, ARGS.cursos_transporte, ARGS.carga_docente


def load_catalogo_metadata(path):
    """Lee Catalogo_metadata.xlsx (RUT/correo/cupos/requisitos para el export del catálogo
    oficial). Devuelve una lista de dicts, uno por fila, con las claves de HEADERS tal cual
    están en la hoja. Si no se indica archivo o no existe, devuelve [].
    """
    if not path or not os.path.exists(path):
        return []
    wb_meta = openpyxl.load_workbook(path, data_only=True)
    ws_meta = wb_meta["Catalogo_metadata"]
    hdr_row = None
    for r in range(1, 6):
        if ws_meta.cell(row=r, column=1).value == "Codigo":
            hdr_row = r
            break
    if hdr_row is None:
        return []
    headers = [ws_meta.cell(row=hdr_row, column=c).value for c in range(1, ws_meta.max_column + 1)]
    out = []
    for row in ws_meta.iter_rows(min_row=hdr_row + 1, values_only=True):
        d = dict(zip(headers, row))
        if not d.get("Codigo"):
            continue
        out.append(d)
    return out


catalogo_metadata_json = load_catalogo_metadata(ARGS.catalogo_metadata)


def load_instrucciones(path):
    """Lee instrucciones de corrección ya ingresadas previamente por el usuario, para no
    perderlas al regenerar el archivo. Acepta dos formatos:
      - un .json exportado desde la app (lista de objetos con al menos 'id' e 'instruccion'), o
      - un Maestro_Cursos_Transporte.xlsx anterior, leyendo su hoja Chequeo_consistencia
        (columnas 'ID' e 'Instrucción de corrección').
    Devuelve un dict {id_hallazgo: texto_instruccion}.
    """
    if not path:
        return {}
    if not os.path.exists(path):
        print(f"Aviso: no se encontró el archivo de instrucciones '{path}', se ignora.")
        return {}
    out = {}
    if path.lower().endswith(".json"):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        items = data if isinstance(data, list) else data.get("instrucciones", [])
        for item in items:
            fid = item.get("id")
            texto = (item.get("instruccion") or "").strip()
            if fid and texto:
                out[fid] = texto
    elif path.lower().endswith(".xlsx"):
        wb_prev = openpyxl.load_workbook(path, data_only=True)
        if "Chequeo_consistencia" in wb_prev.sheetnames:
            ws_prev = wb_prev["Chequeo_consistencia"]
            # La hoja tiene título+subtítulo+fila en blanco antes del encabezado real.
            header_row = None
            for r in ws_prev.iter_rows(min_row=1, max_row=8):
                values = [c.value for c in r]
                if "ID" in values and ("Instrucción de corrección" in values):
                    header_row = r[0].row
                    headers = values
                    break
            if header_row:
                idx_id = headers.index("ID")
                idx_instr = headers.index("Instrucción de corrección")
                for r in ws_prev.iter_rows(min_row=header_row + 1, values_only=True):
                    fid = r[idx_id] if idx_id < len(r) else None
                    texto = (r[idx_instr] if idx_instr < len(r) else None) or ""
                    texto = str(texto).strip()
                    if fid and texto:
                        out[fid] = texto
    else:
        print(f"Aviso: formato de '{path}' no reconocido (se espera .json o .xlsx), se ignora.")
    if out:
        print(f"Instrucciones de corrección cargadas desde '{path}': {len(out)} hallazgo(s) con texto.")
    return out


INSTRUCCIONES_PREVIAS = load_instrucciones(ARGS.instrucciones)

FONT_NAME = "Calibri"
HEADER_FILL = PatternFill("solid", fgColor="1F4E78")
HEADER_FONT = Font(name=FONT_NAME, bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(name=FONT_NAME, bold=True, size=16, color="1F4E78")
SUBTITLE_FONT = Font(name=FONT_NAME, italic=True, size=10, color="595959")
NORMAL_FONT = Font(name=FONT_NAME, size=11)
BOLD_FONT = Font(name=FONT_NAME, bold=True, size=11)
WARN_FILL = PatternFill("solid", fgColor="FFF2CC")
BAD_FILL = PatternFill("solid", fgColor="FCE4E4")
OK_FILL = PatternFill("solid", fgColor="E2EFDA")
INFO_FILL = PatternFill("solid", fgColor="DEEAF6")
INPUT_FILL = PatternFill("solid", fgColor="FFFDE7")  # columna para que el usuario escriba
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

ct, cv2, cd = load_books(ct_path=ARGS.cursos_transporte, cv2_path=ARGS.cursos_v2, cd_path=ARGS.carga_docente)
periodos = get_period_dict(ct)
ct25 = extract_ct_year(ct, "2025")
ct26 = extract_ct_year(ct, "2026")
ct27 = extract_ct_year(ct, "2027")
cv2_rows = extract_cv2(cv2)
cd27 = extract_cd_2027(cd)
comentarios = extract_comentarios(cd)

wb = openpyxl.Workbook()
wb.remove(wb.active)


def style_header(ws, ncols, row=1):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[row].height = 28


def autosize(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def write_table(ws, start_row, headers, rows, widths, title=None, subtitle=None):
    r = start_row
    if title:
        ws.cell(row=r, column=1, value=title).font = TITLE_FONT
        r += 1
    if subtitle:
        ws.cell(row=r, column=1, value=subtitle).font = SUBTITLE_FONT
        r += 1
    r += 1
    header_row = r
    for c, h in enumerate(headers, start=1):
        ws.cell(row=r, column=c, value=h)
    style_header(ws, len(headers), row=r)
    r += 1
    first_data_row = r
    for row in rows:
        for c, v in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = NORMAL_FONT
            cell.border = BORDER
            cell.alignment = Alignment(vertical="center", wrap_text=True)
        r += 1
    autosize(ws, widths)
    ws.freeze_panes = ws.cell(row=first_data_row, column=1).coordinate
    return header_row, first_data_row, r - 1  # last data row

# -------------------------------------------------------------------
# Sheet: Portada / Léeme
# -------------------------------------------------------------------
ws = wb.create_sheet("Léeme")
ws.sheet_view.showGridLines = False
ws["B2"] = "Planificación de cursos — Transporte, DII/FCFM U. de Chile"
ws["B2"].font = Font(name=FONT_NAME, bold=True, size=18, color="1F4E78")
ws["B3"] = "Archivo maestro consolidado a partir de: Cursos_v2.xlsx, Cursos_transporte_2025-2026.xlsx y Carga Docente.xlsx"
ws["B3"].font = SUBTITLE_FONT
ws["B5"] = "Contenido del archivo"
ws["B5"].font = BOLD_FONT
contenido = [
    ("Chequeo_consistencia", "Diferencias e inconsistencias encontradas entre las 3 planillas originales, con recomendación. Revisar primero."),
    ("Diccionario_periodos", "Tabla día.período → horario (normal / extendido), tal como aparece en Cursos_transporte."),
    ("Oferta_2025", "Oferta de cursos de transporte dictada en 2025 (Otoño y Primavera), consolidada desde Cursos_transporte_2025-2026.xlsx."),
    ("Oferta_2026", "Oferta de cursos de transporte dictada en 2026."),
    ("Oferta_2027", "Planificación para 2027 (próximo año): combina Cursos_transporte (horarios) con Carga Docente (profesores y pondera por curso)."),
    ("Carga_docente_2027", "Detalle de carga por profesor y curso 2027, con resumen dinámico (fórmulas) por profesor y balance Obligatorio/Electivo."),
    ("Malla_completa", "Copia de la hoja 'Cursos_v2': todos los cursos de la Facultad (IN, MA, MGO, CI) con día/período, para revisar choques horarios con otros cursos de interés."),
]
r = 6
for name, desc in contenido:
    ws.cell(row=r, column=2, value=name).font = BOLD_FONT
    ws.cell(row=r, column=3, value=desc).font = NORMAL_FONT
    ws.cell(row=r, column=3).alignment = Alignment(wrap_text=True, vertical="center")
    r += 1
ws["B15"] = "Notación de horario: día.período, donde día 1=Lunes … 5=Viernes (6=Sábado) y período según Diccionario_periodos. Un '*' indica horario extendido."
ws["B15"].font = SUBTITLE_FONT
ws["B15"].alignment = Alignment(wrap_text=True)
ws.merge_cells("B15:H15")
ws["B17"] = f"Generado automáticamente — {len(ct25)+len(ct26)+len(ct27)} filas de oferta de transporte revisadas, {len(cv2_rows)} filas de malla completa, {len(cd27)} filas de carga docente 2027."
ws["B17"].font = SUBTITLE_FONT
autosize(ws, [3, 26, 90, 14, 14, 14, 14])

# -------------------------------------------------------------------
# Análisis de consistencia (programático)
# -------------------------------------------------------------------
from collections import defaultdict

cv2_sched = defaultdict(list)          # (codigo, sem_par, tipo) -> [(dia,periodo)]
cv2_sched_named = defaultdict(list)    # (codigo, sem_par, tipo) -> [(dia,periodo,nombre)]
cv2_codigo_nombres = defaultdict(set)  # codigo -> {nombres distintos (texto original)}
cv2_codigo_nombres_norm = defaultdict(set)  # codigo -> {nombres normalizados sin tildes/mayúsculas}
import unicodedata


def fold(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", s.strip().lower())

for row in cv2_rows:
    if row.get("Programa") != "CI":
        continue
    codigo = row.get("Codigo")
    sem_par = row.get("Semestre_par")
    tipo = row.get("Tipo_clase")
    dia, per = row.get("Dia_update"), row.get("Periodo_update")
    nombre = row.get("Nombre")
    if dia is not None and per is not None:
        cv2_sched[(codigo, sem_par, tipo)].append((dia, per))
        cv2_sched_named[(codigo, sem_par, tipo)].append((dia, per, nombre))
    if codigo:
        cv2_codigo_nombres[codigo].add((nombre or "").strip())
        cv2_codigo_nombres_norm[codigo].add(fold(nombre))

findings = []  # each: dict(tipo, curso, severidad, descripcion, fuente, recomendacion)


def finding_id(tipo, curso, descripcion):
    """ID estable del hallazgo (no cambia entre corridas mientras el hallazgo sea el mismo),
    para poder enlazar instrucciones de corrección ingresadas por el usuario a través de
    distintas regeneraciones del archivo."""
    raw = f"{tipo}|{curso}|{descripcion}".encode("utf-8")
    return "H-" + hashlib.sha1(raw).hexdigest()[:10]


def add_finding(tipo, curso, severidad, descripcion, fuente, recomendacion):
    findings.append(dict(id=finding_id(tipo, curso, descripcion), tipo=tipo, curso=curso,
                          severidad=severidad, descripcion=descripcion, fuente=fuente,
                          recomendacion=recomendacion))


def pondera_esperada(creditos):
    """1.0 de pondera equivale a un curso de 6 créditos (pondera = créditos / 6)."""
    return round((creditos or 6) / 6.0, 4)


# 1) Códigos de curso usados para más de un nombre distinto en Cursos_v2
# Nota: filas repetidas (mismo código/semestre/tipo/día/período) ya NO se reportan como hallazgo:
# es el método intencional usado para registrar bloques de cátedra y auxiliar por separado.
# Esto es distinto de un mismo código asignado a dos *nombres de curso* distintos, que sí se reporta
# porque mezclaría horarios de dos asignaturas distintas bajo un solo código.
for codigo, nombres in cv2_codigo_nombres.items():
    if len(cv2_codigo_nombres_norm[codigo]) > 1:
        add_finding(
            "Código compartido por 2 cursos", codigo, "Alta",
            f"El código {codigo} está asignado en Cursos_v2 (hoja Cursos_v2) a {len(nombres)} cursos con nombres "
            f"distintos: " + "; ".join(sorted(nombres)) + ". A diferencia de las filas repetidas para cátedra/auxiliar "
            "(que son intencionales), aquí se trata de dos asignaturas distintas compartiendo un mismo código, lo que "
            "mezcla sus horarios en el chequeo de choques.",
            "Cursos_v2.xlsx (hoja Cursos_v2)",
            "Confirmar si es intencional o si uno de los dos cursos tiene el código equivocado "
            "(ej. 'Competencia y Regulación' podría corresponder a CI5310, no a CI5243).",
        )

# 3) Comparación horario Cursos_transporte vs Cursos_v2 (todas las ofertas de los 3 años)
for year, rows in [("2025", ct25), ("2026", ct26), ("2027", ct27)]:
    for info in rows:
        codigo, sem_par = info["codigo"], info["sem_par"]
        if sem_par is None or codigo is None:
            continue
        cv2_cat = sorted(cv2_sched.get((codigo, sem_par, "C"), []))
        cv2_aux = sorted(cv2_sched.get((codigo, sem_par, "A"), []))
        ct_cat = sorted((d, p) for d, p, _e in info["catedra"])
        ct_aux = sorted((d, p) for d, p, _e in info["auxiliar"])
        if not cv2_cat and not cv2_aux:
            if ct_cat or ct_aux:
                add_finding(
                    "Curso ausente en malla", f"{codigo} {info['nombre']}", "Baja",
                    f"[{year}, {info['semestre']}] Cursos_transporte define horario (cátedra {fmt_horario(info['catedra'])}; "
                    f"auxiliar {fmt_horario(info['auxiliar'])}) pero el curso no aparece en Cursos_v2 (programa CI) para "
                    f"semestre {SEM_MAP_INV.get(sem_par)}.",
                    "Cursos_transporte_2025-2026.xlsx",
                    "Agregar el curso a Cursos_v2 si se quiere incluir en el chequeo de choques con el resto de la Facultad.",
                )
            continue
        if ct_cat != cv2_cat or ct_aux != cv2_aux:
            add_finding(
                "Horario no coincide", f"{codigo} {info['nombre']}", "Alta",
                f"[{year}, {info['semestre']}] Cátedra: Cursos_transporte={fmt_horario(info['catedra'])} vs "
                f"Cursos_v2={fmt_horario([(d,p,False) for d,p in cv2_cat])}. "
                f"Auxiliar: Cursos_transporte={fmt_horario(info['auxiliar'])} vs "
                f"Cursos_v2={fmt_horario([(d,p,False) for d,p in cv2_aux])}.",
                "Cursos_transporte_2025-2026.xlsx vs Cursos_v2.xlsx",
                "Confirmar cuál horario es el vigente y actualizar la otra planilla.",
            )

# 4) Cruce Carga Docente 2027 vs Cursos_transporte 2027 (por nombre+semestre)
ct27_by_key = {(r["nombre_curso"], r["semestre"]): r for r in ct27}
cd27_by_key = defaultdict(list)
for r in cd27:
    cd27_by_key[(r["nombre_curso"], r["semestre"])].append(r)

all_keys = set(ct27_by_key) | set(cd27_by_key)
for key in all_keys:
    nombre_curso, semestre = key
    in_ct, in_cd = key in ct27_by_key, key in cd27_by_key
    if in_ct and not in_cd:
        info = ct27_by_key[key]
        if info["oe"] is None and info["semestre"] is None:
            add_finding(
                "Dato incompleto", nombre_curso, "Media",
                f"En Cursos_transporte (hoja 2027) el curso '{nombre_curso}' no tiene Obligatorio/Electivo ni Semestre "
                f"definidos, pero sí aparece en Carga Docente con esos datos completos.",
                "Cursos_transporte_2025-2026.xlsx (hoja 2027)",
                "Completar O/E y Semestre en Cursos_transporte usando los valores de Carga Docente.",
            )
        else:
            add_finding(
                "Curso ausente en Carga Docente", f"{nombre_curso} ({semestre})", "Media",
                "Aparece en Cursos_transporte (hoja 2027) pero no en Carga Docente / Cursos 2027.",
                "Cursos_transporte_2025-2026.xlsx",
                "Agregar la fila correspondiente en Carga Docente para no perder el cálculo de carga.",
            )
        continue
    if in_cd and not in_ct:
        continue  # ya cubierto por el caso anterior (dato incompleto) cuando corresponde
    ct_info = ct27_by_key[key]
    cd_rows = cd27_by_key[key]
    cd_profs = set()
    for r in cd_rows:
        cd_profs |= {norm_name(n) for n in split_profs_raw(r["profesor"])}
    ct_profs = {norm_name(n) for n in split_profs_raw(ct_info["profesor"])}

    def unmatched(a_set, b_set):
        return [a for a in a_set if not any(a in b or b in a for b in b_set)]

    miss_cd = unmatched(ct_profs, cd_profs)
    miss_ct = unmatched(cd_profs, ct_profs)
    if miss_cd or miss_ct:
        add_finding(
            "Profesores no coinciden", nombre_curso, "Media",
            f"[{semestre}] Profesor(es) en Cursos_transporte no reflejados en Carga Docente: {miss_cd or '—'}. "
            f"Profesor(es) en Carga Docente no mencionados en Cursos_transporte: {miss_ct or '—'}.",
            "Cursos_transporte_2025-2026.xlsx vs Carga Docente.xlsx",
            "Confirmar quién(es) dictan el curso y unificar en ambas planillas.",
        )
    cd_creditos = set(r["creditos"] for r in cd_rows)
    if cd_creditos != {ct_info["creditos"]}:
        pond_hint = ""
        pond_sum_check = round(sum((r["pondera"] or 0) for r in cd_rows), 4)
        for cred_candidate in cd_creditos:
            if cred_candidate and abs(pond_sum_check - cred_candidate / 6.0) < 1e-6:
                pond_hint = (f" La pondera registrada en Carga Docente ({pond_sum_check}) es consistente con "
                             f"{cred_candidate} créditos (pondera=créditos/6), lo que sugiere que ese es el valor correcto.")
        add_finding(
            "Créditos no coinciden", nombre_curso, "Alta",
            f"Créditos en Cursos_transporte={ct_info['creditos']} vs Carga Docente={sorted(cd_creditos)}." + pond_hint,
            "Cursos_transporte_2025-2026.xlsx vs Carga Docente.xlsx",
            "Confirmar el número de créditos correcto del curso y unificarlo en ambas planillas.",
        )
    cd_oe = set(r["oe"] for r in cd_rows)
    if ct_info["oe"] is not None and cd_oe != {ct_info["oe"]}:
        extra = ""
        if nombre_curso.startswith("CI5310") or "Competencia y Regulación" in nombre_curso or "Economía Urbana" in nombre_curso:
            extra = " Nota: la hoja 'Comentarios' de Carga Docente indica que se está considerando pasar este curso a Electivo."
        add_finding(
            "Obligatorio/Electivo no coincide", nombre_curso, "Alta",
            f"O/E en Cursos_transporte={ct_info['oe']!r} vs Carga Docente={sorted(x for x in cd_oe if x)}." + extra,
            "Cursos_transporte_2025-2026.xlsx vs Carga Docente.xlsx",
            "Actualizar Cursos_transporte si el cambio a Electivo ya fue decidido.",
        )
    # Regla de pondera: 1.0 equivale a un curso de 6 créditos (pondera = créditos/6). Si lo dicta
    # más de un profesor, la pondera se reparte entre ellos según las horas de cada uno (no
    # necesariamente en partes iguales), pero la SUMA del curso debe calzar con créditos/6.
    pondera_sum = round(sum((r["pondera"] or 0) for r in cd_rows), 4)
    creditos_ref = cd_rows[0]["creditos"] or 6
    pondera_esperada_val = pondera_esperada(creditos_ref)
    if abs(pondera_sum - pondera_esperada_val) > 1e-6:
        add_finding(
            "Pondera no calza con créditos", nombre_curso, "Media",
            f"La suma de 'Pondera' en Carga Docente para este curso es {pondera_sum}, pero para "
            f"{creditos_ref} créditos debería ser {pondera_esperada_val} (pondera = créditos/6).",
            "Carga Docente.xlsx (hoja Cursos 2027)",
            "Revisar y corregir la pondera de los profesores de este curso.",
        )

# 5) Pivotes desactualizados en Carga Docente
ws_bal = cd["Balance cursos por semestre"]
bal_pivot = {}
for r in ws_bal.iter_rows(min_row=6, values_only=True):
    if not r[0] or r[0] == "Grand Total":
        continue
    bal_pivot[r[0]] = {"Otoño": r[1] or 0, "Primavera": r[2] or 0}
conteo_calc = defaultdict(lambda: defaultdict(int))
for r in cd27:
    conteo_calc[r["oe"]][r["semestre"]] += (r["conteo"] or 0)
for oe in ["O", "E"]:
    for sem in ["Otoño", "Primavera"]:
        calc = conteo_calc[oe][sem]
        piv = bal_pivot.get(oe, {}).get(sem, 0)
        if calc != piv:
            add_finding(
                "Tabla dinámica desactualizada", f"Balance cursos por semestre — {oe}/{sem}", "Baja",
                f"La tabla dinámica 'Balance cursos por semestre' muestra {piv}, pero los datos crudos de "
                f"'Cursos 2027' dan {calc}.",
                "Carga Docente.xlsx (hoja 'Balance cursos por semestre')",
                "Actualizar/refrescar la tabla dinámica en Excel (botón 'Actualizar todo').",
            )

print(f"Total hallazgos: {len(findings)}")

SEV_ORDER = {"Alta": 0, "Media": 1, "Baja": 2}
findings.sort(key=lambda f: SEV_ORDER.get(f["severidad"], 9))
SEV_FILL = {"Alta": BAD_FILL, "Media": WARN_FILL, "Baja": INFO_FILL}

# -------------------------------------------------------------------
# Sheet: Chequeo_consistencia
# -------------------------------------------------------------------
ws = wb.create_sheet("Chequeo_consistencia")
headers = ["ID", "Severidad", "Tipo", "Curso", "Descripción", "Fuente(s)", "Recomendación", "Instrucción de corrección"]
hdr_row, first, last = write_table(
    ws, 1, headers,
    [[f["id"], f["severidad"], f["tipo"], f["curso"], f["descripcion"], f["fuente"], f["recomendacion"],
      INSTRUCCIONES_PREVIAS.get(f["id"], "")] for f in findings],
    widths=[13, 11, 24, 34, 68, 34, 50, 50],
    title="Chequeo de consistencia entre planillas",
    subtitle=(f"{len(findings)} hallazgos — revisar y corregir en las planillas originales. "
              "Alta = datos contradictorios que afectan la planificación; Media = falta de datos o menor relevancia; "
              "Baja = informativo. Columna 'ID' = identificador interno del hallazgo, no editar. Escribe en "
              "'Instrucción de corrección' cómo corregir cada fila, en tu propio lenguaje; ese texto (y el de la app "
              "web, si lo usas ahí) es lo que luego le paso a Claude para que aplique los cambios en las planillas."),
)
for i, f in enumerate(findings):
    row = first + i
    ws.cell(row=row, column=2).fill = SEV_FILL.get(f["severidad"], None)
    ws.cell(row=row, column=2).font = BOLD_FONT
    ws.cell(row=row, column=1).font = Font(name=FONT_NAME, size=8, color="9E9E9E")
    instr_cell = ws.cell(row=row, column=8)
    instr_cell.fill = INPUT_FILL
ws.column_dimensions["A"].hidden = False
ws.auto_filter.ref = f"A{hdr_row}:H{last}"

# -------------------------------------------------------------------
# Sheet: Diccionario_periodos
# -------------------------------------------------------------------
ws = wb.create_sheet("Diccionario_periodos")
write_table(
    ws, 1, ["Período", "Horario normal", "Horario extendido (*)"],
    [[p["periodo"], p["normal"], p["extendido"]] for p in periodos],
    widths=[12, 20, 24],
    title="Diccionario de períodos",
    subtitle="Día 1=Lunes, 2=Martes, 3=Miércoles, 4=Jueves, 5=Viernes, 6=Sábado. Notación: día.período (ej. 2.3 = Martes, período 3).",
)

# -------------------------------------------------------------------
# Sheets: Oferta_2025 / Oferta_2026  (una fila por curso)
# -------------------------------------------------------------------
def build_oferta_simple(ws_name, rows, year):
    ws = wb.create_sheet(ws_name)
    headers = ["Código", "Nombre", "Profesor(es)", "Créditos", "O/E", "Semestre",
               "Horario cátedra", "Horario auxiliar", "Comentario original"]
    table_rows = []
    for info in rows:
        table_rows.append([
            info["codigo"], info["nombre"], info["profesor"], info["creditos"], info["oe"], info["semestre"],
            fmt_horario(info["catedra"]), fmt_horario(info["auxiliar"]), info["comentario"],
        ])
    write_table(ws, 1, headers, table_rows,
                widths=[11, 42, 34, 10, 7, 11, 22, 22, 30],
                title=f"Oferta de cursos de Transporte — {year}",
                subtitle="Consolidado desde Cursos_transporte_2025-2026.xlsx. Ver hoja Chequeo_consistencia para discrepancias detectadas.")
    return ws


build_oferta_simple("Oferta_2025", ct25, "2025 (pasado)")
build_oferta_simple("Oferta_2026", ct26, "2026 (pasado)")

# -------------------------------------------------------------------
# Sheet: Oferta_2027  (próximo año — una fila por curso+profesor, con pondera)
# -------------------------------------------------------------------
ws = wb.create_sheet("Oferta_2027")
headers = ["Código", "Nombre", "Profesor", "Créditos", "O/E", "Semestre", "Pondera",
           "Horario cátedra", "Horario auxiliar", "Observaciones"]

OE_FIX_NOTE = ("O/E y/o Semestre no estaban definidos en Cursos_transporte; se completaron con los valores "
               "de Carga Docente.")
OE_CHANGE_NOTE = ("O/E cambiado de 'O' a 'E' según nota de planificación en hoja Comentarios de Carga Docente "
                   "(cambio aún no reflejado en Cursos_transporte).")

rows_out = []
all_keys = list({(r["nombre_curso"], r["semestre"]) for r in ct27} | {(r["nombre_curso"], r["semestre"]) for r in cd27})
# keep a stable, readable order: by codigo then nombre
all_keys.sort(key=lambda k: (code_from_name(k[0]) or "", k[0], str(k[1])))

for nombre_curso, semestre in all_keys:
    ct_info = ct27_by_key.get((nombre_curso, semestre))
    cd_rows = cd27_by_key.get((nombre_curso, semestre), [])
    codigo = code_from_name(nombre_curso)
    nombre = nombre_sin_codigo(nombre_curso, codigo)
    horario_cat = fmt_horario(ct_info["catedra"]) if ct_info else ""
    horario_aux = fmt_horario(ct_info["auxiliar"]) if ct_info else ""
    if cd_rows:
        for cdr in cd_rows:
            obs = []
            if ct_info is not None and (ct_info["oe"] is None or ct_info["semestre"] is None):
                obs.append(OE_FIX_NOTE)
            if ct_info is not None and ct_info["oe"] and cdr["oe"] and ct_info["oe"] != cdr["oe"]:
                obs.append(OE_CHANGE_NOTE)
            pond = cdr["pondera"]
            pond_sum_row = round(sum((r["pondera"] or 0) for r in cd_rows), 4)
            if pond is not None and abs(pond_sum_row - pondera_esperada(cdr["creditos"])) > 1e-6:
                obs.append(f"Pondera del curso suma {pond_sum_row}, se esperaba {pondera_esperada(cdr['creditos'])} "
                           f"para {cdr['creditos']} créditos (ver Chequeo_consistencia).")
            rows_out.append([
                codigo, nombre, cdr["profesor"], cdr["creditos"], cdr["oe"], cdr["semestre"], cdr["pondera"],
                horario_cat, horario_aux, " / ".join(obs),
            ])
    else:
        obs = ["Curso presente solo en Cursos_transporte (sin fila en Carga Docente)."]
        rows_out.append([
            codigo, nombre, ct_info["profesor"], ct_info["creditos"], ct_info["oe"], ct_info["semestre"], None,
            horario_cat, horario_aux, " / ".join(obs),
        ])

hdr_row, first, last = write_table(
    ws, 1, headers, rows_out,
    widths=[11, 42, 24, 10, 7, 11, 10, 22, 22, 55],
    title="Oferta de cursos de Transporte — 2027 (próximo año)",
    subtitle=("Combina Cursos_transporte (horarios) con Carga Docente (profesores y pondera). "
              "Columna 'Observaciones' documenta datos completados o discrepancias — detalle completo en Chequeo_consistencia."),
)
ws.auto_filter.ref = f"A{hdr_row}:J{last}"
# resaltar filas con observaciones
for row in range(first, last + 1):
    if ws.cell(row=row, column=10).value:
        for c in range(1, 11):
            ws.cell(row=row, column=c).fill = WARN_FILL

# -------------------------------------------------------------------
# Sheet: Carga_docente_2027  (datos crudos + resumen con fórmulas SUMIFS)
# -------------------------------------------------------------------
ws = wb.create_sheet("Carga_docente_2027")
headers = ["Nombre curso", "Profesor", "Créditos", "Pondera", "Curso - conteo", "O/E", "Semestre"]
table_rows = [[r["nombre_curso"], r["profesor"], r["creditos"], r["pondera"], r["conteo"], r["oe"], r["semestre"]]
              for r in cd27]
hdr_row, first, last = write_table(
    ws, 1, headers, table_rows,
    widths=[46, 28, 10, 10, 13, 7, 11],
    title="Carga docente — 2027 (datos crudos)",
    subtitle="Copia de la hoja 'Cursos 2027' de Carga Docente.xlsx. Los resúmenes de la derecha se recalculan solos (fórmulas).",
)
ws.auto_filter.ref = f"A{hdr_row}:G{last}"
data_range_prof = f"$B${first}:$B${last}"
data_range_pond = f"$D${first}:$D${last}"
data_range_sem = f"$G${first}:$G${last}"
data_range_oe = f"$F${first}:$F${last}"
data_range_conteo = f"$E${first}:$E${last}"

# Resumen por profesor (col I..L)
profs = sorted({(r["profesor"] or "").strip() for r in cd27 if r["profesor"]})
ws.cell(row=1, column=9, value="Resumen de carga por profesor (fórmulas)").font = TITLE_FONT
rsum_headers = ["Profesor", "Otoño", "Primavera", "Total"]
for c, h in enumerate(rsum_headers, start=9):
    ws.cell(row=3, column=c, value=h)
for c in range(9, 13):
    cell = ws.cell(row=3, column=c)
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = Alignment(horizontal="center")
r = 4
for p in profs:
    ws.cell(row=r, column=9, value=p).font = NORMAL_FONT
    ws.cell(row=r, column=10, value=(
        f'=SUMIFS($D${first}:$D${last},{data_range_prof},$I{r},$G${first}:$G${last},"Otoño")'
    ))
    ws.cell(row=r, column=11, value=(
        f'=SUMIFS($D${first}:$D${last},{data_range_prof},$I{r},$G${first}:$G${last},"Primavera")'
    ))
    ws.cell(row=r, column=12, value=f"=J{r}+K{r}")
    for c in range(10, 13):
        ws.cell(row=r, column=c).font = NORMAL_FONT
        ws.cell(row=r, column=c).number_format = "0.00"
    r += 1
last_prof_row = r - 1
ws.cell(row=r, column=9, value="Total").font = BOLD_FONT
for c in range(10, 13):
    col = get_column_letter(c)
    ws.cell(row=r, column=c, value=f"=SUM({col}4:{col}{last_prof_row})").font = BOLD_FONT
    ws.cell(row=r, column=c).number_format = "0.00"

# Balance O/E por semestre (col N..Q)
base_col = 14  # N
ws.cell(row=1, column=base_col, value="Balance cursos por semestre (fórmulas)").font = TITLE_FONT
bhead = ["O/E", "Otoño", "Primavera", "Total"]
for i, h in enumerate(bhead):
    cell = ws.cell(row=3, column=base_col + i, value=h)
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = Alignment(horizontal="center")
rr = 4
for oe_val in ["O", "E"]:
    ws.cell(row=rr, column=base_col, value=oe_val).font = NORMAL_FONT
    ws.cell(row=rr, column=base_col + 1, value=(
        f'=SUMIFS($E${first}:$E${last},$F${first}:$F${last},${get_column_letter(base_col)}{rr},'
        f'$G${first}:$G${last},"Otoño")'
    ))
    ws.cell(row=rr, column=base_col + 2, value=(
        f'=SUMIFS($E${first}:$E${last},$F${first}:$F${last},${get_column_letter(base_col)}{rr},'
        f'$G${first}:$G${last},"Primavera")'
    ))
    ws.cell(row=rr, column=base_col + 3, value=f"={get_column_letter(base_col+1)}{rr}+{get_column_letter(base_col+2)}{rr}")
    for c in range(base_col + 1, base_col + 4):
        ws.cell(row=rr, column=c).font = NORMAL_FONT
    rr += 1
ws.cell(row=rr, column=base_col, value="Total").font = BOLD_FONT
for c in range(base_col + 1, base_col + 4):
    col = get_column_letter(c)
    ws.cell(row=rr, column=c, value=f"=SUM({col}4:{col}{rr-1})").font = BOLD_FONT

autosize(ws, [46, 28, 10, 10, 13, 7, 11, 2, 26, 10, 10, 10, 2, 8, 10, 10, 10])

# -------------------------------------------------------------------
# Sheet: Malla_completa (todos los programas, para chequeo de choques)
# -------------------------------------------------------------------
periodo_to_hora = {p["periodo"]: (p["normal"], p["extendido"]) for p in periodos}
collision_codes = {f["curso"] for f in findings if f["tipo"] == "Código compartido por 2 cursos"}

ws = wb.create_sheet("Malla_completa")
headers = ["Código", "Programa", "Articulación Tpte.", "Nombre", "Tipo clase", "Semestre (cohorte)",
           "Semestre (O/P)", "Día", "Período", "Horario normal", "Nota"]
table_rows = []
for row in cv2_rows:
    codigo = row.get("Codigo")
    sem_par = row.get("Semestre_par")
    tipo = row.get("Tipo_clase")
    dia, per = row.get("Dia_update"), row.get("Periodo_update")
    nota = []
    if row.get("Programa") == "CI" and codigo in collision_codes:
        nota.append("Código usado también para otro curso distinto (ver Chequeo_consistencia).")
    hora_normal = periodo_to_hora.get(per, (None, None))[0] if per else None
    table_rows.append([
        codigo, row.get("Programa"), row.get("Articulacion"), row.get("Nombre"), tipo,
        row.get("Semestre"), sem_par, DIAS.get(dia, dia), per, hora_normal, " / ".join(nota),
    ])

hdr_row, first, last = write_table(
    ws, 1, headers, table_rows,
    widths=[10, 10, 15, 40, 10, 14, 13, 11, 9, 16, 55],
    title="Malla completa de la Facultad (IN, MA, MGO, CI)",
    subtitle=("Copia de Cursos_v2.xlsx, hoja 'Cursos_v2' — usar para revisar choques horarios entre cursos de Transporte "
              "y el resto de los cursos de interés. 'Articulación Tpte.'=1 indica cursos articulados con la malla de Transporte."),
)
ws.auto_filter.ref = f"A{hdr_row}:K{last}"
for row in range(first, last + 1):
    if ws.cell(row=row, column=11).value:
        ws.cell(row=row, column=11).fill = WARN_FILL

# Sheet: Catalogo_metadata (RUT/correo/cupos/requisitos para el export del catálogo oficial)
# -------------------------------------------------------------------
if catalogo_metadata_json:
    ws = wb.create_sheet("Catalogo_metadata")
    cm_headers = list(catalogo_metadata_json[0].keys())
    cm_rows = [[row.get(h) for h in cm_headers] for row in catalogo_metadata_json]
    hdr_row, first, last = write_table(
        ws, 1, cm_headers, cm_rows,
        widths=[9, 8, 34, 30, 22, 10, 10, 10, 30, 20, 30, 16, 20, 24, 10, 10, 10, 30, 10, 55][:len(cm_headers)],
        title="Metadatos del catálogo oficial de cursos (RUT, correo, cupos, requisitos)",
        subtitle=("No incluye horarios: esos se calculan siempre en vivo desde Oferta_2027 al exportar el catálogo "
                  "desde la pestaña Horario. Editar esta hoja en Catalogo_metadata.xlsx y volver a correr "
                  "build_master.py para que los cambios lleguen a la app."),
    )
    ws.auto_filter.ref = f"A{hdr_row}:{get_column_letter(len(cm_headers))}{last}"

# Orden de hojas
order = ["Léeme", "Chequeo_consistencia", "Diccionario_periodos", "Oferta_2025", "Oferta_2026",
         "Oferta_2027", "Carga_docente_2027", "Malla_completa"]
if catalogo_metadata_json:
    order.append("Catalogo_metadata")
wb._sheets = [wb[name] for name in order]
wb.active = 0

os.makedirs(os.path.dirname(ARGS.out_xlsx) or ".", exist_ok=True)
wb.save(ARGS.out_xlsx)
print("Malla_completa OK — archivo guardado en", ARGS.out_xlsx)

# -------------------------------------------------------------------
# data.js para la aplicación web (datos estructurados, no sólo texto)
# -------------------------------------------------------------------
import json as _json


def oferta_simple_json(rows):
    out = []
    for info in rows:
        out.append({
            "codigo": info["codigo"], "nombre": info["nombre"], "profesor": info["profesor"],
            "creditos": info["creditos"], "oe": info["oe"], "semestre": info["semestre"],
            "sem_par": info["sem_par"],
            "catedra": [{"dia": d, "periodo": p, "ext": e} for d, p, e in info["catedra"]],
            "auxiliar": [{"dia": d, "periodo": p, "ext": e} for d, p, e in info["auxiliar"]],
            "catedra_txt": fmt_horario(info["catedra"]), "auxiliar_txt": fmt_horario(info["auxiliar"]),
            "comentario": info["comentario"],
        })
    return out


oferta_2027_json = []
for nombre_curso, semestre in all_keys:
    ct_info = ct27_by_key.get((nombre_curso, semestre))
    cd_rows_ = cd27_by_key.get((nombre_curso, semestre), [])
    codigo = code_from_name(nombre_curso)
    nombre = nombre_sin_codigo(nombre_curso, codigo)
    catedra = ct_info["catedra"] if ct_info else []
    auxiliar = ct_info["auxiliar"] if ct_info else []
    base = {
        "codigo": codigo, "nombre": nombre,
        "catedra": [{"dia": d, "periodo": p, "ext": e} for d, p, e in catedra],
        "auxiliar": [{"dia": d, "periodo": p, "ext": e} for d, p, e in auxiliar],
        "catedra_txt": fmt_horario(catedra), "auxiliar_txt": fmt_horario(auxiliar),
    }
    if cd_rows_:
        pond_sum = round(sum((r["pondera"] or 0) for r in cd_rows_), 4)
        for cdr in cd_rows_:
            obs = []
            if ct_info is not None and (ct_info["oe"] is None or ct_info["semestre"] is None):
                obs.append(OE_FIX_NOTE)
            if ct_info is not None and ct_info["oe"] and cdr["oe"] and ct_info["oe"] != cdr["oe"]:
                obs.append(OE_CHANGE_NOTE)
            if abs(pond_sum - pondera_esperada(cdr["creditos"])) > 1e-6:
                obs.append(f"Pondera del curso suma {pond_sum}, se esperaba {pondera_esperada(cdr['creditos'])} "
                           f"para {cdr['creditos']} créditos.")
            row = dict(base)
            row.update({
                "profesor": cdr["profesor"], "creditos": cdr["creditos"], "oe": cdr["oe"],
                "semestre": cdr["semestre"], "sem_par": SEM_MAP.get(cdr["semestre"]),
                "pondera": cdr["pondera"], "observaciones": " / ".join(obs),
            })
            oferta_2027_json.append(row)
    else:
        row = dict(base)
        row.update({
            "profesor": ct_info["profesor"], "creditos": ct_info["creditos"], "oe": ct_info["oe"],
            "semestre": ct_info["semestre"], "sem_par": ct_info["sem_par"],
            "pondera": None, "observaciones": "Curso presente solo en Cursos_transporte (sin fila en Carga Docente).",
        })
        oferta_2027_json.append(row)

malla_json = []
for row in cv2_rows:
    codigo = row.get("Codigo")
    sem_par = row.get("Semestre_par")
    tipo = row.get("Tipo_clase")
    dia, per = row.get("Dia_update"), row.get("Periodo_update")
    nota = []
    if row.get("Programa") == "CI" and codigo in collision_codes:
        nota.append("Código usado también para otro curso distinto.")
    malla_json.append({
        "codigo": codigo, "programa": row.get("Programa"), "articulacion": row.get("Articulacion"),
        "nombre": row.get("Nombre"), "tipo": tipo, "semestre_cohorte": row.get("Semestre"),
        "sem_par": sem_par, "dia": dia, "periodo": per, "nota": " / ".join(nota),
    })

resumen_prof_json = []
pond_by_prof = defaultdict(lambda: defaultdict(float))
for r in cd27:
    if r["profesor"]:
        pond_by_prof[r["profesor"].strip()][r["semestre"]] += (r["pondera"] or 0)
for p in sorted(pond_by_prof):
    o = round(pond_by_prof[p].get("Otoño", 0), 4)
    pr = round(pond_by_prof[p].get("Primavera", 0), 4)
    resumen_prof_json.append({"profesor": p, "otono": o, "primavera": pr, "total": round(o + pr, 4)})

balance_json = []
conteo_by_oe_sem = defaultdict(lambda: defaultdict(int))
for r in cd27:
    conteo_by_oe_sem[r["oe"]][r["semestre"]] += (r["conteo"] or 0)
for oe_val in ["O", "E"]:
    o = conteo_by_oe_sem[oe_val].get("Otoño", 0)
    pr = conteo_by_oe_sem[oe_val].get("Primavera", 0)
    balance_json.append({"oe": oe_val, "otono": o, "primavera": pr, "total": o + pr})

periodos_json = [
    {"Período": p["periodo"], "Horario normal": p["normal"], "Horario extendido (*)": p["extendido"]}
    for p in periodos
]

chequeo_json = [
    {
        "ID": f["id"], "Severidad": f["severidad"], "Tipo": f["tipo"], "Curso": f["curso"],
        "Descripción": f["descripcion"], "Fuente(s)": f["fuente"], "Recomendación": f["recomendacion"],
        "Instrucción de corrección": INSTRUCCIONES_PREVIAS.get(f["id"], ""),
    }
    for f in findings
]

site_data = {
    "generado": "Generado automáticamente desde las planillas de Oferta de Cursos — Transporte UChile.",
    "periodos": periodos_json,
    "oferta_2025": oferta_simple_json(ct25),
    "oferta_2026": oferta_simple_json(ct26),
    "oferta_2027": oferta_2027_json,
    "malla_completa": malla_json,
    "chequeo": chequeo_json,
    "resumen_carga_profesor": resumen_prof_json,
    "balance_oe": balance_json,
    "catalogo_metadata": catalogo_metadata_json,
}

import os
os.makedirs(os.path.dirname(ARGS.out_datajs) or ".", exist_ok=True)
with open(ARGS.out_datajs, "w", encoding="utf-8") as f:
    f.write("// Generado automáticamente — no editar a mano. Ver convert_to_json / build_master.py.\n")
    f.write("const DATA = ")
    _json.dump(site_data, f, ensure_ascii=False, indent=1, default=str)
    f.write(";\n")
print("data.js generado:", {k: len(v) if isinstance(v, list) else v for k, v in site_data.items()})
