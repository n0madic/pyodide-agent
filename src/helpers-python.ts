// ── Python sources for the pre-loaded helper library ───────────────────────
//
// Kept as TS strings (like HOST_EXEC_BLOCKER in pyodide-worker.ts) so nothing
// has to be read from disk at runtime: no `--include` for `deno compile`, no
// extra worker read permissions, nothing to copy in the Dockerfile.
//
// All three sources are concatenated and exec'd into ONE module namespace
// (`helpers`, see helpers.ts), so they may use each other's private names.
// Each source appends its public names to the `__all__` list the loader
// creates beforehand; only those names are copied into the user's globals.
//
// Rules for editing: stdlib only; no backticks and no `${` in the Python text
// (it lives inside String.raw templates).

/** Always loaded: structure/flow helpers shared by every other source. */
export const CORE_PY = String.raw`
import asyncio as _asyncio
import inspect as _inspect
import json as _json
import math as _math
import time as _time
import traceback as _traceback
from collections import Counter as _Counter

__all__.extend(["HelperError", "peek", "emit", "step", "check", "parallel"])


class HelperError(Exception):
    """Expected, actionable failure raised by a helper (bad input, HTTP error, ...)."""


_PEEK_MAX_DEPTH = 3
_PEEK_MAX_KEYS = 25


def _short(x, limit=80):
    try:
        s = repr(x)
    except Exception:
        s = "<" + type(x).__name__ + ">"
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _cap(text, limit, hint="filter or aggregate in code before printing"):
    if len(text) <= limit:
        return text
    cut = text.rfind("\n", 0, limit)
    if cut < limit // 2:
        cut = limit
    return text[:cut] + f"\n… [truncated {len(text) - cut} of {len(text)} chars; {hint}]"


def _jsonable(o):
    """Convert o to plain JSON types: numpy/pandas values become Python values,
    NaN/Infinity become None (they are not valid JSON), other objects become str."""
    if o is None or isinstance(o, (str, bool, int)):
        return o
    if isinstance(o, float):
        return o if _math.isfinite(o) else None
    if isinstance(o, dict):
        return {
            (k if k is None or isinstance(k, (str, int, float, bool)) else str(k)): _jsonable(v)
            for k, v in o.items()
        }
    if isinstance(o, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in o]
    if _is_df(o):
        return _jsonable(o.to_dict(orient="records"))
    if hasattr(o, "tolist"):  # ndarray, numpy scalars, Series
        return _jsonable(o.tolist())
    if hasattr(o, "isoformat"):  # datetime, date, time
        return o.isoformat()
    return str(o)


def _is_df(o):
    return type(o).__name__ == "DataFrame" and hasattr(o, "dtypes") and hasattr(o, "shape")


def _is_arr(o):
    return type(o).__name__ == "ndarray" and hasattr(o, "shape") and hasattr(o, "dtype")


def _desc(obj, n, depth):
    """Describe obj as a list of lines; the first line is the header."""
    if obj is None or isinstance(obj, (bool, int, float, complex)):
        return [_short(obj)]
    if isinstance(obj, str):
        return [f"str(len={len(obj)}) {_short(obj, 100)}"]
    if isinstance(obj, (bytes, bytearray)):
        return [f"{type(obj).__name__}(len={len(obj)}) {_short(bytes(obj[:24]), 60)}"]
    if _is_df(obj):
        rows, cols = obj.shape[0], obj.shape[1]
        lines = [f"DataFrame(rows={rows}, cols={cols})"]
        pairs = list(zip(obj.columns, obj.dtypes))[:_PEEK_MAX_KEYS]
        lines.append("  dtypes: " + ", ".join(f"{c}:{t}" for c, t in pairs))
        if rows:
            lines.extend("  " + l[:200] for l in obj.head(n).to_string(max_cols=20).split("\n"))
        return lines
    if _is_arr(obj):
        lines = [f"ndarray(shape={tuple(obj.shape)}, dtype={obj.dtype})"]
        if obj.size:
            lines.append("  head: " + _short(obj.reshape(-1)[:n].tolist(), 120))
        return lines
    if isinstance(obj, dict):
        lines = [f"dict(len={len(obj)})"]
        if depth >= _PEEK_MAX_DEPTH:
            return lines
        items = list(obj.items())
        for k, v in items[:_PEEK_MAX_KEYS]:
            sub = _desc(v, n, depth + 1)
            lines.append(f"  {_short(k, 40)}: {sub[0]}")
            lines.extend("  " + s for s in sub[1:])
        if len(items) > _PEEK_MAX_KEYS:
            lines.append(f"  … +{len(items) - _PEEK_MAX_KEYS} more keys")
        return lines
    if isinstance(obj, (list, tuple, set, frozenset)):
        seq = list(obj)
        kinds = _Counter(type(x).__name__ for x in seq)
        kind_txt = ", ".join(f"{k}×{c}" for k, c in kinds.most_common(4))
        head = f"{type(obj).__name__}(len={len(seq)}" + (f", items: {kind_txt}" if seq else "") + ")"
        lines = [head]
        if depth >= _PEEK_MAX_DEPTH or not seq:
            return lines
        if all(isinstance(x, dict) for x in seq):
            keys = list(dict.fromkeys(k for x in seq[:200] for k in x))
            more = " …" if len(keys) > _PEEK_MAX_KEYS else ""
            lines.append("  keys: " + ", ".join(_short(k, 30) for k in keys[:_PEEK_MAX_KEYS]) + more)
        for i, x in enumerate(seq[:n]):
            sub = _desc(x, n, depth + 1)
            lines.append(f"  [{i}]: {sub[0]}")
            lines.extend("  " + s for s in sub[1:])
        if len(seq) > n:
            lines.append(f"  … +{len(seq) - n} more")
        return lines
    return [f"{type(obj).__name__} {_short(obj, 100)}"]


def peek(obj, n=5):
    """Print a compact structural description of obj (keys, types, shape, first n items)."""
    print(_cap("\n".join(_desc(obj, n, 0)), 3000, "peek a smaller part"))


def _cell(v, width=60):
    if v is None:
        return ""
    if isinstance(v, str):
        s = v
    elif isinstance(v, (dict, list, tuple)):
        s = _json.dumps(v, ensure_ascii=False, default=str)
    else:
        s = str(v)
    s = s.replace("\n", " ").replace("|", "\\|")
    return s if len(s) <= width else s[: width - 1] + "…"


def _table(rows, budget, max_cols=20):
    """Markdown table that stops formatting rows once budget characters are used."""
    cols = list(dict.fromkeys(k for r in rows[:200] for k in r))[:max_cols]
    out = [
        "| " + " | ".join(_cell(c, 40) for c in cols) + " |",
        "|" + "|".join(" --- " for _ in cols) + "|",
    ]
    used = sum(len(l) + 1 for l in out)
    for i, r in enumerate(rows):
        line = "| " + " | ".join(_cell(r.get(c)) for c in cols) + " |"
        if used + len(line) > budget:
            out.append(f"… +{len(rows) - i} more rows")
            break
        out.append(line)
        used += len(line) + 1
    return "\n".join(out)


def emit(x, limit=4000):
    """Print x compactly: list of dicts -> markdown table, DataFrame -> text table,
    other containers -> JSON. Output beyond limit chars is cut and marked."""
    if isinstance(x, str):
        text = x
    elif _is_df(x):
        text = x.to_string(max_rows=30, max_cols=20)
        if x.shape[0] > 30:
            text += f"\n[{x.shape[0]} rows x {x.shape[1]} cols]"
    elif isinstance(x, (list, tuple)) and x and all(isinstance(r, dict) for r in x):
        text = _table(list(x), max(limit - 80, 200))
    else:
        try:
            text = _json.dumps(_jsonable(x), indent=2, ensure_ascii=False)
        except Exception:  # e.g. circular references
            text = str(x)
    print(_cap(text, limit))


def _user_line(tb):
    frames = _traceback.extract_tb(tb)
    for f in reversed(frames):
        if f.filename == "<exec>":
            return f"line {f.lineno}"
    if frames:
        return f"{frames[-1].filename}:{frames[-1].lineno}"
    return "line ?"


class step:
    """Context manager for one stage of a script.

    Prints a check mark with the elapsed time, or a cross with the error and the
    line number. on_error="continue" (default) swallows the exception so the
    rest of the script still runs; on_error="raise" re-raises it.
    """

    def __init__(self, name, on_error="continue"):
        if on_error not in ("continue", "raise"):
            raise ValueError('step: on_error must be "continue" or "raise"')
        self.name = name
        self.on_error = on_error

    def __enter__(self):
        self._t0 = _time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, tb):
        elapsed = _time.perf_counter() - self._t0
        if exc_type is None:
            print(f"✓ {self.name} ({elapsed:.1f}s)")
            return False
        if not issubclass(exc_type, Exception):
            return False  # KeyboardInterrupt, SystemExit, CancelledError pass through
        msg = " ".join(str(exc).split())[:300]
        print(f"✗ {self.name}: {exc_type.__name__}: {msg} ({_user_line(tb)})")
        return self.on_error == "continue"


def check(cond, msg):
    """Print CHECK ✓/✗ with msg and return bool(cond); never raises (an ambiguous
    condition such as a DataFrame counts as failed and says why)."""
    try:
        ok = bool(cond)
    except Exception as e:
        why = " ".join(str(e).split())[:120]
        print(f"CHECK ✗ {msg} (condition not evaluable: {type(e).__name__}: {why})")
        return False
    print(f"CHECK {'✓' if ok else '✗'} {msg}")
    return ok


async def parallel(coros, limit=5):
    """Await coroutines concurrently (at most limit at once); results keep input order.
    The first exception propagates and cancels the rest - catch inside each coroutine
    to keep partial results."""
    if not isinstance(limit, int) or limit < 1:
        raise HelperError(f"parallel: limit must be an integer >= 1, got {limit!r}")
    coros = list(coros)
    sem = _asyncio.Semaphore(limit)

    async def run(c):
        async with sem:
            return await c

    tasks = [_asyncio.ensure_future(run(c)) for c in coros]
    try:
        return list(await _asyncio.gather(*tasks))
    except BaseException:
        for t in tasks:
            t.cancel()
        await _asyncio.gather(*tasks, return_exceptions=True)
        for c in coros:
            if _inspect.iscoroutine(c):
                c.close()  # never started: avoid "was never awaited" noise
        raise
`;

/**
 * File helpers. Work on any path Python can see: the sandbox's in-memory
 * filesystem always, plus /host when --mount-dir is active.
 * Depends on CORE_PY (HelperError, _is_df).
 */
export const FS_PY = String.raw`
import csv as _csv
import io as _io
import os as _os
import re as _re
import sys as _sys
from pathlib import Path as _Path, PurePosixPath as _PurePosixPath

__all__.extend(["load", "save", "files", "grep"])

_TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".rst", ".log", ".html", ".htm", ".xml", ".ini",
    ".cfg", ".toml", ".sql", ".sh", ".py", ".js", ".ts", ".css",
}
_GREP_MAX_BYTES = 5_000_000
_HOST_ROOT = "/host"
_written = set()  # absolute paths created or updated by save() in this session


def _need_module(name, why):
    try:
        return __import__(name)
    except ImportError:
        raise HelperError(
            f"{why} needs {name}: add 'import {name}' at the top of your script "
            f"(Pyodide loads it automatically on import)"
        ) from None


def _read_text(p):
    # Decode bytes ourselves: Path.read_text() would translate \r\n inside quoted CSV fields.
    return p.read_bytes().decode("utf-8-sig", errors="replace")


def _load_df(p, ext):
    pd = _need_module("pandas", "load(df=True)")
    if ext == ".csv":
        return pd.read_csv(p)
    if ext == ".tsv":
        return pd.read_csv(p, sep="\t")
    if ext == ".json":
        return pd.read_json(p)
    if ext in (".jsonl", ".ndjson"):
        return pd.read_json(p, lines=True)
    raise HelperError(f"load(df=True): unsupported extension {ext or '(none)'}; use csv/tsv/json/jsonl")


def load(path, df=False):
    """Read a file by extension: json/jsonl -> objects, csv/tsv -> list of dicts (str values),
    yaml -> objects, text files -> str, binary files -> bytes. df=True -> pandas DataFrame."""
    p = _Path(path)
    if not p.is_file():
        hint = " (it is a directory; use files())" if p.is_dir() else ""
        raise HelperError(f"load: not a file: {path}{hint}")
    ext = p.suffix.lower()
    try:
        if df:
            return _load_df(p, ext)
        if ext == ".json":
            return _json.loads(_read_text(p))
        if ext in (".jsonl", ".ndjson"):
            return [_json.loads(l) for l in _read_text(p).splitlines() if l.strip()]
        if ext in (".csv", ".tsv"):
            delim = "\t" if ext == ".tsv" else ","
            return list(_csv.DictReader(_io.StringIO(_read_text(p), newline=""), delimiter=delim))
        if ext in (".yaml", ".yml"):
            return _need_module("yaml", "YAML").safe_load(_read_text(p))
        if ext in _TEXT_EXTS:
            return _read_text(p)
        raw = p.read_bytes()
        if b"\0" not in raw[:8192]:  # looks like text: decode, else keep bytes
            try:
                return raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                pass
        return raw
    except HelperError:
        raise
    except Exception as e:
        raise HelperError(f"load: cannot parse {path}: {type(e).__name__}: {e}") from e


def _csv_cell(v):
    return _json.dumps(_jsonable(v), ensure_ascii=False) if isinstance(v, (dict, list, tuple)) else v


def _to_csv(obj, delim):
    if _is_df(obj):
        return obj.to_csv(index=False, sep=delim)
    if not isinstance(obj, (list, tuple)) or not all(isinstance(r, (dict, list, tuple)) for r in obj):
        raise HelperError("save: csv/tsv needs a list of dicts, a list of rows, or a DataFrame")
    buf = _io.StringIO()
    w = _csv.writer(buf, delimiter=delim, lineterminator="\n")
    if obj and all(isinstance(r, dict) for r in obj):
        cols = list(dict.fromkeys(k for r in obj for k in r))
        w.writerow(cols)
        for r in obj:
            w.writerow([_csv_cell(r.get(c)) for c in cols])
    else:
        for r in obj:
            w.writerow([_csv_cell(v) for v in r])
    return buf.getvalue()


def _serialize(obj, ext):
    if isinstance(obj, (bytes, bytearray)):
        return bytes(obj)
    if ext == ".json":
        return _json.dumps(_jsonable(obj), indent=2, ensure_ascii=False).encode("utf-8")
    if ext in (".jsonl", ".ndjson"):
        rows = _jsonable(obj)
        if not isinstance(rows, list):
            raise HelperError("save: jsonl needs a list (or a DataFrame)")
        return "".join(_json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode("utf-8")
    if ext in (".csv", ".tsv"):
        return _to_csv(obj, "\t" if ext == ".tsv" else ",").encode("utf-8")
    if ext in (".yaml", ".yml"):
        yaml = _need_module("yaml", "YAML")
        return yaml.safe_dump(_jsonable(obj), allow_unicode=True, sort_keys=False).encode("utf-8")
    if isinstance(obj, str):
        return obj.encode("utf-8")
    raise HelperError(
        f"save: cannot write {type(obj).__name__} as {ext or 'a file without extension'}; "
        f"pass str/bytes, or use .json/.jsonl/.csv/.tsv/.yaml"
    )


def _abs(path):
    return _os.path.normpath(_os.path.abspath(str(path)))


def _under_host(path):
    a = _abs(path)
    return a == _HOST_ROOT or a.startswith(_HOST_ROOT + "/")


def save(obj, path, overwrite=False):
    """Write obj by extension (json/jsonl/csv/tsv/yaml; str and bytes as-is), creating
    parent directories. Returns {"path", "bytes", "existed"} - existed is True if it overwrote a file.
    A file under /host that existed before this session is never overwritten unless
    overwrite=True (ask the user first); files this session wrote itself can be re-saved."""
    p = _Path(path)
    if p.is_dir():
        raise HelperError(f"save: {path} is a directory")
    if p.exists() and not overwrite and _under_host(p) and _abs(p) not in _written:
        raise HelperError(
            f"save: {path} already exists on the host and was not created in this session; "
            f"ask the user, then call save(..., overwrite=True)"
        )
    try:
        data = _serialize(obj, p.suffix.lower())
    except HelperError:
        raise
    except Exception as e:
        raise HelperError(f"save: cannot serialize for {path}: {type(e).__name__}: {e}") from e
    existed = p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    _written.add(_abs(p))
    return {"path": str(p), "bytes": len(data), "existed": existed}


def _truncation_note(what, limit):
    print(f"{what}: results truncated at {limit}; narrow the pattern/glob", file=_sys.stderr)


def _iter_files(root, pattern):
    """Yield file paths under root whose root-relative path matches the glob pattern.
    Deterministic order (each directory's files first, then its subdirectories, sorted);
    lazy, so callers can stop early on huge trees. Symlinked directories are not followed."""
    if pattern.startswith("/"):
        raise HelperError(f"pattern must be relative to root, got {pattern!r}")
    base = str(root).rstrip("/") or "/"
    for dirpath, dirnames, filenames in _os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            full = _os.path.join(dirpath, name)
            if _PurePosixPath(_os.path.relpath(full, base)).full_match(pattern):
                yield full


def files(root, pattern="**/*", max=500):
    """List files under root matching a glob pattern relative to root: [{"path", "size"}]."""
    if not _os.path.isdir(root):
        raise HelperError(f"files: not a directory: {root}")
    out = []
    for full in _iter_files(root, pattern):
        if len(out) >= max:
            _truncation_note("files", max)
            break
        try:
            out.append({"path": full, "size": _os.path.getsize(full)})
        except OSError:
            continue
    return out


def grep(pattern, root, glob="**/*", max=100, context=0):
    """Regex search over text files under root (or one file): [{"path", "line", "text"}],
    plus "before"/"after" line lists when context > 0. Binary and >5 MB files are skipped."""
    try:
        rx = _re.compile(pattern)
    except _re.error as e:
        raise HelperError(f"grep: bad regex {pattern!r}: {e}") from None
    if _os.path.isfile(root):
        candidates = [str(root)]
    elif _os.path.isdir(root):
        candidates = _iter_files(root, glob)
    else:
        raise HelperError(f"grep: no such path: {root}")
    hits = []
    truncated = False
    for path in candidates:
        try:
            if _os.path.getsize(path) > _GREP_MAX_BYTES:
                continue
            with open(path, "rb") as f:
                raw = f.read()
        except OSError:
            continue
        if b"\0" in raw[:4096]:
            continue
        lines = raw.decode("utf-8", errors="replace").splitlines()
        for i, line in enumerate(lines):
            if not rx.search(line):
                continue
            if len(hits) >= max:
                truncated = True
                break
            hit = {"path": path, "line": i + 1, "text": line[:300]}
            if context:
                lo = i - context if i > context else 0
                hit["before"] = [l[:300] for l in lines[lo:i]]
                hit["after"] = [l[:300] for l in lines[i + 1 : i + 1 + context]]
            hits.append(hit)
        if truncated:
            _truncation_note("grep", max)
            break
    return hits
`;

/** Network helpers; only loaded when --allow-net is active. Depends on CORE_PY. */
export const NET_PY = String.raw`
import re as _re
from html.parser import HTMLParser as _HTMLParser
from urllib.parse import urlencode as _urlencode, urljoin as _urljoin
from pyodide.ffi import JsException as _JsException
from pyodide.http import AbortError as _AbortError
from pyodide.http import pyfetch as _pyfetch  # tests replace this to avoid real network

__all__.extend(["fetch", "fetch_many", "html_to_md", "html_links"])

_RETRY_STATUS = {429, 500, 502, 503, 504}
_IDEMPOTENT = {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}
_NETWORK_ERRORS = (_JsException, _AbortError, OSError, _asyncio.TimeoutError)
_BACKOFF = 0.5  # seconds; doubled per retry
_AS_MODES = ("json", "text", "bytes", "md")


def _retry_delay(attempt, resp):
    delay = _BACKOFF * (2 ** attempt)
    try:
        headers = {str(k).lower(): v for k, v in resp.headers.items()}
        if "retry-after" in headers:
            delay = max(delay, min(float(headers["retry-after"]), 10.0))
    except Exception:
        pass
    return delay


async def _read_body(resp, as_, method, url, timeout):
    if as_ == "bytes":
        return await _asyncio.wait_for(resp.bytes(), timeout)
    text = await _asyncio.wait_for(resp.string(), timeout)
    if as_ == "text":
        return text
    if as_ == "md":
        return html_to_md(text, url)
    try:
        return _json.loads(text)
    except ValueError as e:
        raise HelperError(
            f"{method} {url}: response is not valid JSON ({e}); starts with {text[:120]!r}"
        ) from None


async def fetch(url, as_="json", method=None, headers=None, json=None, data=None, timeout=20, retries=2):
    """HTTP request with retries, a status check and body parsing.
    as_: "json" | "text" | "bytes" | "md" (HTML -> Markdown). method defaults to GET, or POST when
    json=/data= is given. json= sends a JSON body; data= sends a form (dict), str or bytes.
    Network errors, timeouts and 429/5xx are retried with exponential backoff (retries times);
    POST/PATCH are only retried on 429, never on 5xx or network errors, so a write is not repeated.
    Non-2xx raises HelperError with the status and the start of the body."""
    if as_ not in _AS_MODES:
        raise HelperError(f"fetch: as_ must be one of {_AS_MODES}, got {as_!r}")
    if not isinstance(retries, int) or retries < 0:
        raise HelperError(f"fetch: retries must be an integer >= 0, got {retries!r}")
    if not timeout or timeout <= 0:
        raise HelperError(f"fetch: timeout must be > 0 seconds, got {timeout!r}")
    if json is not None and data is not None:
        raise HelperError("fetch: pass either json= or data=, not both")
    has_body = json is not None or data is not None
    method = (method or ("POST" if has_body else "GET")).upper()
    if has_body and method in ("GET", "HEAD"):
        raise HelperError(f"fetch: a {method} request cannot have a body; use method='POST' (or PUT/PATCH)")
    idempotent = method in _IDEMPOTENT

    hdrs = dict(headers or {})
    kwargs = {"method": method}
    if json is not None:
        kwargs["body"] = _json.dumps(_jsonable(json))
        hdrs.setdefault("Content-Type", "application/json")
    elif data is not None:
        if isinstance(data, dict):
            kwargs["body"] = _urlencode(data, doseq=True)
            hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            kwargs["body"] = data
    if hdrs:
        kwargs["headers"] = hdrs

    for attempt in range(retries + 1):
        last = attempt >= retries
        try:
            resp = await _asyncio.wait_for(_pyfetch(url, **kwargs), timeout)
        except _NETWORK_ERRORS as e:
            if last or not idempotent:
                raise HelperError(
                    f"{method} {url}: network error after {attempt + 1} attempt(s): {type(e).__name__}: {e}"
                ) from None
            await _asyncio.sleep(_retry_delay(attempt, None))
            continue
        except Exception as e:  # usage/programming errors are not transient: fail fast
            raise HelperError(f"{method} {url}: request could not be sent: {type(e).__name__}: {e}") from None
        status = resp.status
        if (status == 429 or (status in _RETRY_STATUS and idempotent)) and not last:
            await _asyncio.sleep(_retry_delay(attempt, resp))
            continue
        if not 200 <= status < 300:
            try:
                body = " ".join((await _asyncio.wait_for(resp.string(), timeout)).split())[:200]
            except Exception:
                body = "(body unreadable)"
            raise HelperError(f"{method} {url} -> HTTP {status}: {body}")
        return await _read_body(resp, as_, method, url, timeout)


async def fetch_many(items, as_="json", limit=5, **opts):
    """Fetch many URLs concurrently (at most limit at once). items are URL strings or dicts
    {"url": ..., **fetch kwargs}. Returns [{"url", "ok", "data" | "error"}] in input order;
    a failure (including a malformed item) never aborts the others."""

    async def one(item):
        if isinstance(item, str):
            url, spec = item, {}
        elif isinstance(item, dict) and isinstance(item.get("url"), str):
            url, spec = item["url"], {k: v for k, v in item.items() if k != "url"}
        else:
            return {"url": repr(item)[:100], "ok": False,
                    "error": "HelperError: each item must be a URL string or a dict with a 'url' key"}
        try:
            return {"url": url, "ok": True, "data": await fetch(url, **{"as_": as_, **opts, **spec})}
        except Exception as e:
            return {"url": url, "ok": False, "error": f"{type(e).__name__}: {e}"}

    return await parallel([one(i) for i in items], limit)


_SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "iframe", "head"}
_BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "main", "nav", "aside",
    "table", "blockquote", "figure", "form", "dl", "dt", "dd", "details", "summary",
}
_HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
_TICK = chr(96)  # a literal backtick cannot appear in this TS template
_FENCE = _TICK * 3


class _MdParser(_HTMLParser):
    def __init__(self, base_url=""):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.out = []
        self.skip = []
        self.pre = 0
        self.pre_buf = []
        self.pre_blocks = []  # kept out of the text until the end so cleanup cannot touch them
        self.lists = []
        self.anchors = []
        self.in_cell = False
        self.first_cell = True

    def _inline(self):
        # Inside a link or a table cell block elements must not break the line.
        return bool(self.anchors) or self.in_cell

    def _brk(self, sep="\n\n"):
        if not self._inline():
            self.out.append(sep)
        elif self._last_char() not in ("", "\n", " "):
            self.out.append(" ")

    def _last_char(self):
        for piece in reversed(self.out):
            if piece:
                return piece[-1]
        return ""

    def handle_starttag(self, tag, attrs):
        if tag == "body" and "head" in self.skip:
            self.skip = [t for t in self.skip if t != "head"]
        if tag in _SKIP_TAGS:
            self.skip.append(tag)
            return
        if self.skip:
            return
        if self.pre and tag != "pre":
            if tag == "br":
                self.pre_buf.append("\n")
            return
        a = dict(attrs)
        if tag in _HEADINGS:
            if not self._inline():
                self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "br":
            self._brk("\n")
        elif tag == "hr":
            self._brk("\n\n---\n\n")
        elif tag in ("ul", "ol"):
            if not self.lists:
                self.out.append("\n")
            self.lists.append([tag, 0])
        elif tag == "li":
            depth = max(len(self.lists) - 1, 0)
            marker = "- "
            if self.lists and self.lists[-1][0] == "ol":
                self.lists[-1][1] += 1
                marker = f"{self.lists[-1][1]}. "
            self.out.append("\n" + "  " * depth + marker)
        elif tag == "a":
            self.anchors.append((a.get("href"), len(self.out)))
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("*")
        elif tag == "code":
            self.out.append(_TICK)
        elif tag == "pre":
            self.pre += 1
            if self.pre == 1:
                self.pre_buf = []
        elif tag == "tr":
            self.in_cell = False
            self.first_cell = True
        elif tag in ("td", "th"):
            if not self.first_cell:
                self.out.append(" | ")
            self.first_cell = False
            self.in_cell = True
        elif tag in _BLOCK_TAGS:
            self._brk()

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            if tag in self.skip:
                idx = len(self.skip) - 1 - self.skip[::-1].index(tag)
                del self.skip[idx]
            return
        if self.skip:
            return
        if self.pre and tag != "pre":
            return
        if tag in _HEADINGS:
            if not self._inline():
                self.out.append("\n\n")
        elif tag in ("ul", "ol"):
            if self.lists:
                self.lists.pop()
            if not self.lists:
                self.out.append("\n")
        elif tag == "a" and self.anchors:
            href, start = self.anchors.pop()
            if href and not href.strip().lower().startswith(("javascript:", "#")):
                text = "".join(self.out[start:]).strip()
                del self.out[start:]
                url = _urljoin(self.base, href.strip()) if self.base else href.strip()
                if text:
                    self.out.append(f"[{text}]({url})")
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("*")
        elif tag == "code":
            self.out.append(_TICK)
        elif tag == "pre":
            self.pre = max(self.pre - 1, 0)
            if self.pre == 0:
                block = "".join(self.pre_buf).strip("\n")
                self.pre_blocks.append(f"{_FENCE}\n{block}\n{_FENCE}")
                self.out.append(f"\n\nPRE{len(self.pre_blocks) - 1}\n\n")
        elif tag in ("td", "th"):
            self.in_cell = False
        elif tag == "tr":
            self.in_cell = False
            self.out.append("\n")
        elif tag in _BLOCK_TAGS:
            self._brk()

    def handle_data(self, data):
        if self.skip:
            return
        if self.pre:
            self.pre_buf.append(data)
            return
        text = _re.sub(r"\s+", " ", data)
        if text.startswith(" ") and self._last_char() in ("", "\n", " "):
            text = text.lstrip()
        if text:
            self.out.append(text)

    def result(self):
        text = "".join(self.out)
        text = "\n".join(line.rstrip() for line in text.split("\n"))
        text = _re.sub(r"(?<=\S) {2,}", " ", text)  # keeps leading list indentation
        text = _re.sub(r"\n{3,}", "\n\n", text).strip()
        for i, block in enumerate(self.pre_blocks):
            text = text.replace(f"PRE{i}", block)
        return text


def html_to_md(html, base_url=""):
    """Convert HTML to readable Markdown-ish text: drops scripts/styles/head, keeps headings,
    lists, emphasis, tables (as rows) and links (absolute when base_url is given)."""
    if isinstance(html, (bytes, bytearray)):
        html = bytes(html).decode("utf-8", errors="replace")
    p = _MdParser(base_url)
    p.feed(html)
    p.close()
    return p.result()


class _LinkParser(_HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.cur = None

    def _flush(self):
        if self.cur:
            href, parts = self.cur
            self.links.append((href, " ".join("".join(parts).split())))
        self.cur = None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._flush()
            href = dict(attrs).get("href")
            self.cur = (href.strip(), []) if href and href.strip() else None

    def handle_data(self, data):
        if self.cur:
            self.cur[1].append(data)

    def handle_endtag(self, tag):
        if tag == "a":
            self._flush()


def html_links(html, base_url=""):
    """Return [{"url", "text"}] for every link in the HTML: absolute (relative to base_url),
    de-duplicated, without fragments-only, javascript:, mailto: and tel: links."""
    if isinstance(html, (bytes, bytearray)):
        html = bytes(html).decode("utf-8", errors="replace")
    p = _LinkParser()
    p.feed(html)
    p.close()
    p._flush()
    seen = {}
    for href, text in p.links:
        if href.lower().startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        url = _urljoin(base_url, href) if base_url else href
        if url not in seen:
            seen[url] = {"url": url, "text": text}
        elif text and not seen[url]["text"]:
            seen[url]["text"] = text
    return list(seen.values())
`;
