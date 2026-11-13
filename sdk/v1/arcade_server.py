# sdk/v1/arcade_server.py — a web app's Python server, inside Pyodide.
#
# lib/py-server.js runs this in a sandboxed frame on the host's phone, then
# calls `install(...)` once and `call(...)` per request. The author's app is
# an ordinary ASGI (FastAPI, Starlette) or WSGI (Flask) app; nothing here
# asks them to change it. Three things make that work in a browser:
#
#   stubs     a dependency that cannot run here (a database client, say) is
#             importable but inert: using it raises, importing it does not.
#             An app that only touches it when configured runs unconfigured.
#   threads   Pyodide has none, and Starlette runs a plain `def` endpoint in
#             a thread pool (anyio.to_thread). Here it just runs.
#   the call  no uvicorn: one request is one ASGI call with a built scope.

import asyncio
import importlib
import importlib.abc
import importlib.machinery
import io
import sys
import types

APP = None
KIND = "asgi"


class _Missing(type):
    """A name from a package that isn't here: a class, so `X | None` and
    subclassing still work; calling it says what is missing."""

    def __call__(cls, *a, **k):
        raise ImportError(f"{cls.__module__} isn't available in the arcade")

    def __getattr__(cls, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _missing(cls.__module__, name)


def _missing(module, name):
    return _Missing(name, (), {"__module__": module})


class _StubLoader(importlib.abc.Loader):
    def create_module(self, spec):
        m = types.ModuleType(spec.name)
        m.__getattr__ = lambda name: _missing(spec.name, name)
        m.__path__ = []
        return m

    def exec_module(self, module):
        pass


class _StubFinder(importlib.abc.MetaPathFinder):
    def __init__(self, names):
        self.names = {n.replace("-", "_").lower() for n in names}

    def find_spec(self, fullname, path, target=None):
        if fullname.split(".")[0].lower() in self.names:
            return importlib.machinery.ModuleSpec(fullname, _StubLoader(), is_package=True)
        return None


def _culprit(err, path):
    """The installed package an import failure came from: the outermost frame
    in site-packages, or the module that was not found."""
    for frame in __import__("traceback").extract_tb(err.__traceback__):
        if "/site-packages/" in frame.filename:
            return frame.filename.split("/site-packages/", 1)[1].split("/", 1)[0].removesuffix(".py")
    name = getattr(err, "name", None)
    if isinstance(err, ImportError) and name and not __import__("os").path.exists(path + name.split(".")[0]):
        return name.split(".")[0]
    return None


def install(stubs, path, kind, target):
    """Make the app importable and import it. `target` is "module:attr".

    A package that fails to import (a version that does not fit Pyodide's,
    a C extension with no browser build) is stubbed and the import tried
    again: an app that only uses it when configured still runs."""
    global APP, KIND
    finder = _StubFinder(stubs)
    sys.meta_path.append(finder)
    try:
        import anyio.to_thread

        async def run_sync(func, *args, **kwargs):
            return func(*args)

        anyio.to_thread.run_sync = run_sync
    except ImportError:
        pass  # not an anyio app
    sys.path.insert(0, path)
    module, _, attr = target.partition(":")
    stubbed = []
    for _ in range(12):
        before = set(sys.modules)
        try:
            APP = getattr(importlib.import_module(module), attr or "app")
            break
        except Exception as err:
            culprit = _culprit(err, path)
            if not culprit or culprit.lower() in finder.names:
                raise
            print(f"[arcade] {culprit} would not import ({type(err).__name__}: {err}); using a stub")
            finder.names.add(culprit.lower())
            stubbed.append(culprit)
            for name in set(sys.modules) - before:
                del sys.modules[name]
    else:
        raise ImportError(f"{target} would not import")
    KIND = kind
    return stubbed


async def call(method, path, query, headers, body):
    """One request: returns (status, [(name, value)], body bytes)."""
    body = bytes(body)
    if KIND == "wsgi":
        return _wsgi(method, path, query, headers, body)
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "root_path": "",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
        "client": ("arcade", 0),
        "server": ("arcade", 80),
    }
    done = asyncio.get_event_loop().create_future()
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await done
        return {"type": "http.disconnect"}

    out = {"status": 500, "headers": [], "body": b""}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
            out["headers"] = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in message.get("headers", [])]
        elif message["type"] == "http.response.body":
            out["body"] += message.get("body", b"")

    try:
        await APP(scope, receive, send)
    finally:
        done.set_result(None)
    return out["status"], out["headers"], out["body"]


def _wsgi(method, path, query, headers, body):
    environ = {
        "REQUEST_METHOD": method,
        "SCRIPT_NAME": "",
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "SERVER_NAME": "arcade",
        "SERVER_PORT": "80",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "arcade",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(body),
        "wsgi.errors": sys.stderr,
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
        "CONTENT_LENGTH": str(len(body)),
    }
    for k, v in headers:
        name = k.upper().replace("-", "_")
        if name == "CONTENT_TYPE":
            environ["CONTENT_TYPE"] = v
        elif name != "CONTENT_LENGTH":
            environ["HTTP_" + name] = v
    got = {}

    def start_response(status, response_headers, exc_info=None):
        got["status"] = int(status.split(" ", 1)[0])
        got["headers"] = response_headers

    result = APP(environ, start_response)
    try:
        data = b"".join(result)
    finally:
        getattr(result, "close", lambda: None)()
    return got.get("status", 500), got.get("headers", []), data
