import os
import re
import unicodedata
import openpyxl

# Rutas por defecto: se asume que este script corre desde la carpeta
# "Oferta cursos" con "Carga Docente.xlsx" un nivel más arriba, como en
# OneDrive/UChile/2. Coordinación docencia/. Puedes sobrescribirlas con
# variables de entorno o pasando argumentos a build_master.py.
_DEFAULT_DIR = os.path.dirname(os.path.abspath(__file__))
CT_PATH = os.environ.get("CT_PATH", os.path.join(_DEFAULT_DIR, "Cursos_transporte_2025-2026.xlsx"))
CV2_PATH = os.environ.get("CV2_PATH", os.path.join(_DEFAULT_DIR, "Cursos_v2.xlsx"))
CD_PATH = os.environ.get("CD_PATH", os.path.join(_DEFAULT_DIR, "..", "Carga Docente.xlsx"))

SEM_MAP = {"Otoño": "O", "Primavera": "P"}
SEM_MAP_INV = {"O": "Otoño", "P": "Primavera"}

DIAS = {1: "Lunes", 2: "Martes", 3: "Miércoles", 4: "Jueves", 5: "Viernes", 6: "Sábado"}


def code_from_name(nombre_curso):
    m = re.match(r"^([A-Z]{2,6}\d{0,4}[A-Z]{0,2})\s", nombre_curso or "")
    return m.group(1).strip() if m else None


def nombre_sin_codigo(nombre_curso, codigo):
    if not nombre_curso:
        return nombre_curso
    if codigo and nombre_curso.startswith(codigo):
        return nombre_curso[len(codigo):].strip()
    return nombre_curso.strip()


def looks_like_code(s):
    if s is None:
        return False
    if isinstance(s, (int, float)):
        return True
    toks = re.split(r"[,\s]+", str(s).strip())
    ok = 0
    for t in toks:
        t = t.strip().rstrip(".").replace("*", "")
        if not t:
            continue
        if re.match(r"^\d+\.\d+$", t):
            ok += 1
        else:
            return False
    return ok > 0


def parse_horario(s):
    """Returns list of (dia:int, periodo:int, extendido:bool)"""
    if s is None:
        return []
    if isinstance(s, (int, float)):
        s = str(s)
    tokens = re.split(r"[,\s]+", s.strip())
    out = []
    for t in tokens:
        t = t.strip().rstrip(".")
        if not t:
            continue
        ext = "*" in t
        t2 = t.replace("*", "")
        m = re.match(r"^(\d+)\.(\d+)$", t2)
        if m:
            out.append((int(m.group(1)), int(m.group(2)), ext))
    return out


def fmt_horario(pairs):
    """pairs: list of (dia,periodo,ext) -> 'Lunes P3, Viernes P3*'"""
    out = []
    for d, p, ext in pairs:
        s = f"{DIAS.get(d, d)} P{p}"
        if ext:
            s += "*"
        out.append(s)
    return "; ".join(out)


def split_profs_raw(s):
    """Split a 'Profesor' field into a list of individual professor name strings,
    handling 'Apellido, Inicial.' patterns and ';' / ',' separators."""
    if not s:
        return []
    parts = re.split(r";", s)
    names = []
    for p in parts:
        subparts = [x.strip() for x in p.split(",")]
        buf = ""
        for sp in subparts:
            if re.match(r"^[A-Z]\.?$", sp) and buf:
                buf += ", " + sp
            else:
                if buf:
                    names.append(buf)
                buf = sp
        if buf:
            names.append(buf)
    return [n for n in names if n]


def norm_name(n):
    """Normaliza nombres de profesores: minúsculas, sin tildes (para evitar falsos
    positivos por inconsistencias de tipeo como 'cristian' vs 'cristián'), espacios
    colapsados. Conserva la 'ñ' porque cambia el nombre, no es un error de tipeo."""
    s = (n or "").lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not (unicodedata.combining(c) and c != "̃"))
    s = unicodedata.normalize("NFC", s)  # recompone "n" + tilde combinante -> "ñ"
    key = re.sub(r"[^a-zñ ]", "", s).strip()
    return re.sub(r"\s+", " ", key)


def load_books(ct_path=None, cv2_path=None, cd_path=None):
    ct = openpyxl.load_workbook(ct_path or CT_PATH, data_only=True)
    cv2 = openpyxl.load_workbook(cv2_path or CV2_PATH, data_only=True)
    cd = openpyxl.load_workbook(cd_path or CD_PATH, data_only=True)
    return ct, cv2, cd


def get_period_dict(ct):
    """From sheet '2025', columns J,K,L (period legend)."""
    ws = ct["2025"]
    out = []
    for r in ws.iter_rows(min_row=4, max_row=11, values_only=True):
        periodo, normal, extendido = r[9], r[10], r[11]
        if periodo is None:
            continue
        out.append({"periodo": periodo, "normal": normal, "extendido": extendido})
    return out


def extract_ct_year(ct, year):
    """Returns list of dict rows for a Cursos_transporte year sheet, using whichever
    column-pair (F/G or H/I) actually contains día.período codes."""
    ws = ct[year]
    rows = []
    for r in ws.iter_rows(min_row=3, values_only=True):
        nombre_curso = r[0]
        if not nombre_curso:
            continue
        codigo = code_from_name(nombre_curso)
        profesor, creditos, oe, semestre = r[1], r[2], r[3], r[4]
        sem_par = SEM_MAP.get(semestre)
        catF, auxG = r[5], r[6]
        catH, auxI = (r[7], r[8]) if len(r) > 8 else (None, None)
        comentario = r[9] if len(r) > 9 else None
        if looks_like_code(catF) or looks_like_code(auxG):
            cat_src, aux_src = catF, auxG
            texto_src = (r[7] if len(r) > 7 else None, r[8] if len(r) > 8 else None)
        elif looks_like_code(catH) or looks_like_code(auxI):
            cat_src, aux_src = catH, auxI
            texto_src = (None, None)
        else:
            cat_src, aux_src = catF, auxG
            texto_src = (catH, auxI)
        rows.append({
            "nombre_curso": nombre_curso.strip(),
            "codigo": codigo,
            "nombre": nombre_sin_codigo(nombre_curso, codigo),
            "profesor": profesor,
            "creditos": creditos,
            "oe": oe,
            "semestre": semestre,
            "sem_par": sem_par,
            "catedra": parse_horario(cat_src),
            "auxiliar": parse_horario(aux_src),
            "catedra_texto": texto_src[0],
            "auxiliar_texto": texto_src[1],
            "comentario": comentario,
        })
    return rows


def extract_cv2(cv2):
    ws = cv2["Cursos_v2"]
    headers = [c.value for c in ws[1]]
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        row = dict(zip(headers, r))
        if all(v is None for v in r):
            continue
        rows.append(row)
    return rows


def extract_cd_2027(cd):
    ws = cd["Cursos 2027"]
    rows = []
    for r in ws.iter_rows(min_row=3, values_only=True):
        nombre = r[0]
        if not nombre:
            continue
        codigo = code_from_name(nombre)
        rows.append({
            "nombre_curso": nombre.strip(),
            "codigo": codigo,
            "nombre": nombre_sin_codigo(nombre, codigo),
            "profesor": r[1],
            "creditos": r[2],
            "pondera": r[3],
            "conteo": r[4],
            "oe": r[5],
            "semestre": r[6],
        })
    return rows


def extract_comentarios(cd):
    ws = cd["Comentarios"]
    return [r[0] for r in ws.iter_rows(min_row=2, values_only=True) if r[0]]
