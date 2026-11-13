"""scripts/py-deps.py — what a web app's Python server needs, as Pyodide can load it.

Called by scripts/app-build.mjs:

    python3 scripts/py-deps.py <out dir> <pyodide-lock.json> <python version> <dep>...

Each dependency, and each of theirs, is one of:

    in the lock  Pyodide's own build (sdk/v1/pyodide/): loaded by name
    a wheel      a pure-Python wheel from PyPI, saved to <out dir>
    missing      nothing that runs in a browser; the server imports it as a
                 stub (sdk/v1/arcade_server.py), and so does every package
                 that needed it

Printed as JSON: {"deps": [...], "wheels": [...], "missing": [...]}.
Only wheels are downloaded (pip --only-binary), so nothing here runs a
package's code. Versions are not solved, only names: the newest pure wheel
of each, next to whatever Pyodide has — best effort, and the server's import
falls back to a stub for anything that then fails to import.
"""

import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# Servers that run the app; here the arcade does.
RUNNERS = {"uvicorn", "gunicorn", "hypercorn", "daphne", "waitress", "granian"}


def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def marker_ok(marker, py):
    """A Requires-Dist marker: extras are never wanted; python_version is
    compared; anything else (os, platform) is assumed true."""
    if not marker:
        return True
    if "extra" in marker:
        return False
    for op, ver in re.findall(r'python_(?:full_)?version\s*(<=|>=|==|!=|<|>)\s*["\']([\d.]+)["\']', marker):
        a = tuple(int(x) for x in py.split("."))
        b = tuple(int(x) for x in ver.split("."))
        n = max(len(a), len(b))
        a, b = a + (0,) * (n - len(a)), b + (0,) * (n - len(b))
        if not {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b, "==": a == b, "!=": a != b}[op]:
            return False
    return True


def requires(wheel, py):
    with zipfile.ZipFile(wheel) as z:
        meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
        text = z.read(meta).decode("utf-8", "replace")
    out = []
    for line in text.splitlines():
        if line.startswith("Requires-Dist:"):
            spec, _, marker = line[len("Requires-Dist:") :].partition(";")
            name = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", spec)
            if name and marker_ok(marker.strip(), py):
                out.append(name.group(1))
    return out


def download(name, into, py):
    before = set(into.iterdir())
    r = subprocess.run(
        [sys.executable, "-m", "pip", "download", "--quiet", "--disable-pip-version-check", "--no-deps",
         "--only-binary=:all:", "--platform", "any", "--abi", "none", "--implementation", "py",
         "--python-version", py, "-d", str(into), name],
        capture_output=True, text=True,
    )
    new = [p for p in into.iterdir() if p not in before and p.suffix == ".whl"]
    return new[0] if r.returncode == 0 and new else None


def main():
    out, lock_file, py, *wanted = sys.argv[1:]
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    lock = {norm(k) for k in json.load(open(lock_file))["packages"]}
    deps, wheels, missing = set(), {}, set()
    needed_by = {}
    todo = [(w, None) for w in wanted]
    seen = set()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        while todo:
            name, parent = todo.pop()
            key = norm(name)
            if parent:
                needed_by.setdefault(key, set()).add(parent)
            if key in seen or key in RUNNERS:
                continue
            seen.add(key)
            if key in lock:
                deps.add(name)
                continue
            wheel = download(name, tmp, py)
            if not wheel:
                missing.add(key)
                continue
            wheels[key] = wheel
            todo += [(r, key) for r in requires(wheel, py)]
        # A package that needs a missing one is missing too.
        changed = True
        while changed:
            changed = False
            for key, parents in needed_by.items():
                if key in missing:
                    for p in parents:
                        if p in wheels:
                            missing.add(p)
                            del wheels[p]
                            changed = True
        kept = []
        for key, wheel in sorted(wheels.items()):
            (out / wheel.name).write_bytes(wheel.read_bytes())
            kept.append(wheel.name)
    print(json.dumps({"deps": sorted(deps), "wheels": kept, "missing": sorted(missing)}))


main()
