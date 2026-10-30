import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { join } from "@std/path";
import { runPython, runPythonOk } from "./_pyodide.ts";

// Each test boots a real Pyodide session. Python snippets assert internally and
// print "OK" last; a failed assert surfaces its traceback via runPythonOk.
const PERMS = { read: true, write: true, run: true } as const;

function pyTest(
  name: string,
  code: string,
  opts?: Parameters<typeof runPythonOk>[1],
) {
  Deno.test({
    name,
    permissions: PERMS,
    async fn() {
      const out = await runPythonOk(code, opts);
      assert(out.trim().endsWith("OK"), `unexpected output:\n${out}`);
    },
  });
}

pyTest(
  "no-net mode defines flow+fs helpers, not net helpers, and leaks no privates",
  String.raw`
import agent_helpers as helpers
for n in ["peek", "emit", "step", "check", "parallel", "HelperError",
          "load", "save", "files", "grep"]:
    assert n in globals(), n
for n in ["fetch", "fetch_many", "html_to_md", "html_links"]:
    assert n not in globals(), n
    assert not hasattr(helpers, n), n
assert not [k for k in globals() if k.startswith("_pyodide_agent")], "installer leaked"
assert "_desc" not in globals() and "_pyfetch" not in globals()
assert "agent_helpers" in __import__("sys").modules
assert "helpers" not in __import__("sys").modules      # must not shadow a user's helpers.py
print("OK")
`,
);

pyTest(
  "save/load round-trip: json, jsonl, csv, tsv, yaml, text, bytes",
  String.raw`
import os
rows = [{"a": 1, "b": "x|y", "c": [1, 2]}, {"a": 2, "b": "ünï", "c": None}]
r = save(rows, "/tmp/t/deep/dir/data.json")
assert r == {"path": "/tmp/t/deep/dir/data.json", "bytes": r["bytes"], "existed": False}, r
assert load("/tmp/t/deep/dir/data.json") == rows
assert save(rows, "/tmp/t/deep/dir/data.json")["existed"] is True

save(rows, "/tmp/t/d.jsonl")
assert load("/tmp/t/d.jsonl") == rows

save(rows, "/tmp/t/d.csv")
back = load("/tmp/t/d.csv")
assert [r["a"] for r in back] == ["1", "2"], back          # csv values are strings
assert back[0]["c"] == "[1, 2]" and back[1]["c"] == "", back
assert back[1]["b"] == "ünï"

save([[1, 2], [3, 4]], "/tmp/t/rows.tsv")
assert open("/tmp/t/rows.tsv").read() == "1\t2\n3\t4\n"

save({"k": [1, {"z": "é"}]}, "/tmp/t/c.yaml")
assert load("/tmp/t/c.yaml") == {"k": [1, {"z": "é"}]}

save("hello\nworld", "/tmp/t/n.txt")
assert load("/tmp/t/n.txt") == "hello\nworld"
save("# t", "/tmp/t/n.md")
assert load("/tmp/t/n.md") == "# t"

save(b"\x00\x01\x02", "/tmp/t/blob.bin")
assert load("/tmp/t/blob.bin") == b"\x00\x01\x02"

# BOM is stripped
open("/tmp/t/bom.json", "wb").write(b"\xef\xbb\xbf" + b'{"ok": true}')
assert load("/tmp/t/bom.json") == {"ok": True}
print("OK")
`,
);

pyTest(
  "save/load report actionable HelperErrors",
  String.raw`
def raises(fn, needle):
    try:
        fn()
    except HelperError as e:
        assert needle in str(e), str(e)
    else:
        raise AssertionError("no HelperError for " + needle)

raises(lambda: load("/tmp/nope.json"), "not a file")
raises(lambda: load("/tmp"), "files()")
open("/tmp/bad.json", "w").write("{oops")
raises(lambda: load("/tmp/bad.json"), "cannot parse /tmp/bad.json")
raises(lambda: save(object(), "/tmp/x.txt"), "cannot write object")
raises(lambda: save({"a": 1}, "/tmp/x.csv"), "csv/tsv needs")
raises(lambda: save(1, "/tmp"), "is a directory")
raises(lambda: load("/tmp/bad.json", df=True), "pandas")
print("OK")
`,
);

pyTest(
  "files and grep on a temp tree",
  String.raw`
import os
for rel, text in {
    "a.md": "alpha\nTODO one\nbeta\n",
    "sub/b.md": "TODO two\nTODO three\n",
    "sub/c.txt": "nothing\n",
}.items():
    save(text, "/tmp/tree/" + rel)
save(b"\x00TODO binary", "/tmp/tree/bin.dat")

fs = files("/tmp/tree")
assert [f["path"] for f in fs] == [
    "/tmp/tree/a.md", "/tmp/tree/bin.dat", "/tmp/tree/sub/b.md", "/tmp/tree/sub/c.txt"], fs
assert fs[0]["size"] == len("alpha\nTODO one\nbeta\n")
assert [f["path"] for f in files("/tmp/tree", "**/*.md")] == ["/tmp/tree/a.md", "/tmp/tree/sub/b.md"]
assert len(files("/tmp/tree", max=2)) == 2

hits = grep(r"TODO", "/tmp/tree")
assert [(h["path"], h["line"], h["text"]) for h in hits] == [
    ("/tmp/tree/a.md", 2, "TODO one"),
    ("/tmp/tree/sub/b.md", 1, "TODO two"),
    ("/tmp/tree/sub/b.md", 2, "TODO three"),
], hits                                   # binary file skipped
assert len(grep("TODO", "/tmp/tree", max=2)) == 2
assert [h["path"] for h in grep("TODO", "/tmp/tree", glob="sub/*.md")] == ["/tmp/tree/sub/b.md"] * 2
ctx = grep("TODO one", "/tmp/tree/a.md", context=1)[0]
assert ctx["before"] == ["alpha"] and ctx["after"] == ["beta"], ctx
assert grep("(?i)ALPHA", "/tmp/tree/a.md")[0]["line"] == 1

for bad in (lambda: files("/tmp/missing"), lambda: grep("(", "/tmp/tree"), lambda: grep("x", "/tmp/missing"),
            lambda: files("/tmp/tree", "/tmp/tree/*.md")):
    try:
        bad()
    except HelperError:
        pass
    else:
        raise AssertionError("expected HelperError")
print("OK")
`,
);

pyTest(
  "peek describes nested structures compactly",
  String.raw`
import io, contextlib
def cap(obj, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        peek(obj, **kw)
    return buf.getvalue()

data = {"users": [{"id": i, "name": "n%d" % i, "tags": ["a", "b"]} for i in range(100)],
        "meta": {"page": 1, "next": None, "deep": {"x": {"y": {"z": 1}}}},
        "blob": b"abc", "text": "hello " * 100}
out = cap(data, n=2)
assert "dict(len=4)" in out, out
assert "'users': list(len=100, items: dict×100)" in out, out
assert "keys: 'id', 'name', 'tags'" in out, out
assert "[1]: dict(len=3)" in out and "[2]" not in out, out
assert "… +98 more" in out, out
assert "'page': 1" in out and "'next': None" in out, out
assert "'blob': bytes(len=3)" in out and "'text': str(len=600)" in out, out
assert "dict(len=1)" in out        # depth limit reached inside meta.deep
assert len(out) < 1500, len(out)

assert cap(5).strip() == "5"
assert cap([]).strip() == "list(len=0)"
assert cap({i: i for i in range(100)}).count("\n") <= 27     # key cap
big = cap({"k%d" % i: "v" * 500 for i in range(25)})
assert "truncated" in big and len(big) < 3300, len(big)
print("OK")
`,
);

pyTest(
  "emit: tables, JSON, truncation marker",
  String.raw`
import io, contextlib
def cap(x, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        emit(x, **kw)
    return buf.getvalue()

t = cap([{"a": 1, "b": "x|y"}, {"a": 2, "c": None}])
assert t.splitlines()[0] == "| a | b | c |", t
assert "| 1 | x\\|y |  |" in t, t
assert cap({"k": [1, 2]}) == '{\n  "k": [\n    1,\n    2\n  ]\n}\n'
assert cap("plain") == "plain\n"
assert '"(\'tuple\', \'key\')": 1' in cap({("tuple", "key"): 1})     # non-str keys are stringified
assert cap({"nan": float("nan"), "inf": float("inf")}) == '{\n  "nan": null,\n  "inf": null\n}\n'
rows = [{"k": "v" * 40, "i": i} for i in range(5000)]
big = cap(rows, limit=600)
assert len(big) <= 700 and "more rows" in big, (len(big), big[-120:])

long = cap(["line %d" % i for i in range(2000)], limit=500)
assert len(long) < 700, len(long)
assert "truncated" in long and "of " in long, long
assert long.index("truncated") > 400
cell = cap([{"v": "x" * 500}])
assert "…" in cell and len(cell) < 200, cell
print("OK")
`,
);

pyTest(
  "step: markers, timing, continue vs raise, line numbers",
  String.raw`
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    with step("fine"):
        pass
    with step("broken"):
        x = 1
        raise ValueError("bad\nvalue")
    after = True
    def inner():
        return {}["missing"]
    with step("nested"):
        inner()
out = buf.getvalue().splitlines()
assert out[0].startswith("✓ fine (") and out[0].endswith("s)"), out
assert out[1] == "✗ broken: ValueError: bad value (line 9)", out
assert out[2] == "✗ nested: KeyError: 'missing' (line 12)", out
assert after

reached = False
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        with step("fatal", on_error="raise"):
            1 / 0
        reached = True
except ZeroDivisionError:
    pass
assert not reached and buf.getvalue().startswith("✗ fatal: ZeroDivisionError"), buf.getvalue()

try:
    step("x", on_error="bogus")
except ValueError:
    pass
else:
    raise AssertionError("bad on_error accepted")

# BaseException subclasses are never swallowed
try:
    with step("exit"):
        raise KeyboardInterrupt
except KeyboardInterrupt:
    pass
else:
    raise AssertionError("KeyboardInterrupt swallowed")
print("OK")
`,
);

pyTest(
  "check prints and returns without raising",
  String.raw`
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    a = check(1 + 1 == 2, "math works")
    b = check([], "list non-empty")
assert a is True and b is False
assert buf.getvalue().splitlines() == ["CHECK ✓ math works", "CHECK ✗ list non-empty"]
print("OK")
`,
);

pyTest(
  "parallel keeps order and caps concurrency",
  String.raw`
import asyncio
running = peak = 0
async def work(i):
    global running, peak
    running += 1
    peak = max(peak, running)
    await asyncio.sleep(0.02 * (5 - i % 5))   # finish out of order
    running -= 1
    return i * i

res = await parallel([work(i) for i in range(12)], limit=3)
assert res == [i * i for i in range(12)], res
assert peak == 3, peak

async def boom():
    raise RuntimeError("boom")
try:
    await parallel([work(1), boom()])
except RuntimeError as e:
    assert str(e) == "boom"
else:
    raise AssertionError("exception swallowed")
print("OK")
`,
);

pyTest(
  "html_to_md and html_links on fixed HTML",
  String.raw`
html = """<!doctype html><html><head><title>T</title><style>p{}</style>
<script>var x = "<a href='/evil'>no</a>";</script></head>
<body><nav><a href="/">Home</a></nav>
<h1>Main   title</h1>
<p>Some <b>bold</b> and <em>soft</em> text with <a href="/docs/a?x=1&amp;y=2">a link</a>
and <code>code()</code>.</p>
<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
<ol><li>first</li><li>second</li></ol>
<table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>
<pre>  indented
    block</pre>
<p><a href="#frag">skip</a> <a href="mailto:x@y.z">mail</a> <a href="https://other.org/p">Other</a>
<a href="/docs/a?x=1&amp;y=2">again</a></p>
<noscript>enable js</noscript>
</body></html>"""
md = html_to_md(html, "https://example.com/base/")
assert "evil" not in md and "var x" not in md and "enable js" not in md and "p{}" not in md, md
assert "# Main title" in md, md
assert "Some **bold** and *soft* text with [a link](https://example.com/docs/a?x=1&y=2)" in md, md
assert "and " + chr(96) + "code()" + chr(96) + "." in md, md
assert "- one\n- two\n  - nested" in md, md
assert "1. first\n2. second" in md, md
assert "k | v\na | 1" in md, md
assert "  indented\n    block" in md, md
assert "\n\n\n" not in md

links = html_links(html, "https://example.com/base/")
assert links == [
    {"url": "https://example.com/", "text": "Home"},
    {"url": "https://example.com/docs/a?x=1&y=2", "text": "a link"},
    {"url": "https://other.org/p", "text": "Other"},
], links
assert html_to_md(b"<p>caf\xc3\xa9</p>") == "café"
print("OK")
`,
  { allowNet: true },
);

pyTest(
  "load: CRLF inside quoted CSV fields, text sniffing for unknown extensions",
  String.raw`
open("/tmp/crlf.csv", "wb").write(b'a,b\r\n"x\r\ny",2\r\n')
assert load("/tmp/crlf.csv") == [{"a": "x\r\ny", "b": "2"}]

save("package main\nfunc main() {}\n", "/tmp/main.go")
assert load("/tmp/main.go") == "package main\nfunc main() {}\n"
open("/tmp/notes.dat", "wb").write("héllo".encode())
assert load("/tmp/notes.dat") == "héllo"
open("/tmp/bad.dat", "wb").write(b"\x80\x81\x82")
assert load("/tmp/bad.dat") == b"\x80\x81\x82"
open("/tmp/nul.dat", "wb").write(b"ab\x00cd")
assert load("/tmp/nul.dat") == b"ab\x00cd"
print("OK")
`,
);

pyTest(
  "save: NaN becomes null, nested values stay JSON-safe",
  String.raw`
import datetime
save({"x": float("nan"), "d": datetime.date(2020, 1, 2), "s": {1, 2}, "t": (1, 2)}, "/tmp/j.json")
text = open("/tmp/j.json").read()
assert "NaN" not in text, text
back = load("/tmp/j.json")
assert back["x"] is None and back["d"] == "2020-01-02" and sorted(back["s"]) == [1, 2] and back["t"] == [1, 2], back
print("OK")
`,
);

pyTest(
  "check never raises, even for ambiguous truth values",
  String.raw`
import io, contextlib
class Ambiguous:
    def __bool__(self):
        raise ValueError("The truth value of an array is ambiguous")
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    r = check(Ambiguous(), "has rows")
assert r is False
assert buf.getvalue().startswith("CHECK ✗ has rows (condition not evaluable: ValueError: The truth value"), buf.getvalue()
print("OK")
`,
);

Deno.test({
  name: "parallel: first failure cancels the rest, validates limit, leaves no noise",
  permissions: PERMS,
  async fn() {
    const [r] = await runPython([String.raw`
import asyncio
done = []
async def slow(i):
    await asyncio.sleep(0.05)
    done.append(i)
    return i
async def boom():
    await asyncio.sleep(0.01)
    raise RuntimeError("boom")

try:
    await parallel([boom()] + [slow(i) for i in range(6)], limit=3)
except RuntimeError as e:
    assert str(e) == "boom"
else:
    raise AssertionError("no error")
await asyncio.sleep(0.2)
assert done == [], done                       # nothing kept running in the background

for bad in (0, -1, 1.5, None):
    try:
        await parallel([], limit=bad)
    except HelperError:
        pass
    else:
        raise AssertionError(bad)
print("OK")
`]);
    assert(r.ok, `${r.stdout}\n${r.stderr}`);
    assertStringIncludes(r.stdout, "OK");
    assertEquals(r.stderr, "", "unexpected warnings on stderr");
  },
});

pyTest(
  "html_to_md: pre fidelity, block elements inside cells and links, case-insensitive schemes",
  String.raw`
md = html_to_md("<pre>a\n\n\n\nb   \n  c</pre><p>after</p>")
assert md == chr(96) * 3 + "\na\n\n\n\nb   \n  c\n" + chr(96) * 3 + "\n\nafter", repr(md)

md = html_to_md("<table><tr><td><p>a</p></td><td><div>b</div></td></tr><tr><td>c</td><td>d</td></tr></table>")
assert md == "a | b\nc | d", repr(md)

md = html_to_md('<a href="/x"><h2>Title</h2><p>sub</p></a>', "http://h/")
assert md == "[Title sub](http://h/x)", repr(md)

html = '<a href="JavaScript:void(0)">j</a><a href="MAILTO:a@b.c">m</a><a href="TEL:1">t</a><a href="/ok">ok</a>'
assert html_links(html, "http://h/") == [{"url": "http://h/ok", "text": "ok"}]
assert "JavaScript" not in html_to_md(html, "http://h/")
print("OK")
`,
  { allowNet: true },
);

Deno.test({
  name: "save never overwrites pre-existing files under /host unless asked",
  permissions: PERMS,
  async fn() {
    const mountDir = await Deno.makeTempDir({ prefix: "pyodide-agent-mount-" });
    await Deno.writeTextFile(join(mountDir, "keep.txt"), "original");
    try {
      const [r] = await runPython([String.raw`
try:
    save("clobber", "/host/keep.txt")
except HelperError as e:
    assert "overwrite=True" in str(e), str(e)
else:
    raise AssertionError("pre-existing host file was overwritten")
assert open("/host/keep.txt").read() == "original"

first = save("a", "/host/new.txt")
again = save("b", "/host/new.txt")                    # created by this session: re-saving is fine
assert first["existed"] is False and again["existed"] is True
assert open("/host/new.txt").read() == "b"

assert save("yes", "/host/keep.txt", overwrite=True)["existed"] is True
assert open("/host/keep.txt").read() == "yes"

save("x", "/tmp/free.txt"); save("y", "/tmp/free.txt")  # the in-memory FS is unrestricted
assert [f["path"] for f in files("/host")] == ["/host/keep.txt", "/host/new.txt"]
print("OK")
`], { mountDir });
      assert(r.ok, `${r.stdout}\n${r.stderr}`);
      assertStringIncludes(r.stdout, "OK");
      assertEquals(await Deno.readTextFile(join(mountDir, "new.txt")), "b");
    } finally {
      await Deno.remove(mountDir, { recursive: true });
    }
  },
});

// Fake `pyfetch`: lets fetch()/fetch_many() run without any real network.
const FAKE_NET = String.raw`
import json as _j, agent_helpers as helpers, asyncio

class FakeResp:
    def __init__(self, status=200, body="", headers=None):
        self.status, self._body, self.headers = status, body, headers or {}
    async def string(self): return self._body
    async def bytes(self): return self._body.encode()

calls = []
script = {}   # url -> list of FakeResp (consumed in order, last one repeats)

async def fake_pyfetch(url, **kw):
    calls.append((url, kw))
    seq = script.get(url)
    if seq is None:
        raise OSError("connection refused")
    resp = seq.pop(0) if len(seq) > 1 else seq[0]
    if isinstance(resp, Exception):
        raise resp
    return resp

helpers._pyfetch = fake_pyfetch
helpers._BACKOFF = 0
`;

pyTest(
  "fetch: as_ modes, request shaping, retries, errors",
  FAKE_NET + String.raw`
async def expect_err(coro, *needles):
    try:
        await coro
    except HelperError as e:
        for n in needles:
            assert n in str(e), (n, str(e))
    else:
        raise AssertionError("no HelperError")

script["http://x/j"] = [FakeResp(200, '{"a": [1, 2]}')]
assert await fetch("http://x/j") == {"a": [1, 2]}
assert await fetch("http://x/j", as_="text") == '{"a": [1, 2]}'
assert await fetch("http://x/j", as_="bytes") == b'{"a": [1, 2]}'
script["http://x/h"] = [FakeResp(200, "<h1>Hi</h1><p><a href='/n'>next</a></p>")]
assert await fetch("http://x/h", as_="md") == "# Hi\n\n[next](http://x/n)"

# request shaping
calls.clear()
await fetch("http://x/j", method="POST", json={"q": 1}, headers={"X-A": "b"})
url, kw = calls[0]
assert kw["method"] == "POST" and kw["body"] == '{"q": 1}', kw
assert kw["headers"] == {"X-A": "b", "Content-Type": "application/json"}, kw
calls.clear()
await fetch("http://x/j", method="POST", data={"a": "b c"})
assert calls[0][1]["body"] == "a=b+c" and \
    calls[0][1]["headers"]["Content-Type"] == "application/x-www-form-urlencoded"
await expect_err(fetch("http://x/j", json=1, data="x"), "either json= or data=")
await expect_err(fetch("http://x/j", as_="xml"), "as_ must be")

# retry on 503 then succeed; Retry-After is honoured (sleep patched out via _BACKOFF=0)
script["http://x/flaky"] = [FakeResp(503), FakeResp(429, headers={"Retry-After": "0"}), FakeResp(200, '{"ok": true}')]
calls.clear()
assert await fetch("http://x/flaky") == {"ok": True}
assert len(calls) == 3

# still failing after the retries -> HelperError with status and body start
script["http://x/down"] = [FakeResp(503, "  upstream   down\n")]
calls.clear()
await expect_err(fetch("http://x/down", retries=1), "HTTP 503", "upstream down")
assert len(calls) == 2

# 404 is not retried
script["http://x/404"] = [FakeResp(404, "nope")]
calls.clear()
await expect_err(fetch("http://x/404"), "GET http://x/404 -> HTTP 404: nope")
assert len(calls) == 1

# network errors are retried, then reported
calls.clear()
await expect_err(fetch("http://x/unreachable", retries=2), "network error after 3 attempt", "connection refused")
assert len(calls) == 3
script["http://x/blip"] = [OSError("reset"), FakeResp(200, "1")]
assert await fetch("http://x/blip") == 1

# invalid JSON is a clear, non-retried error
script["http://x/bad"] = [FakeResp(200, "<html>")]
calls.clear()
await expect_err(fetch("http://x/bad"), "not valid JSON", "<html>")
assert len(calls) == 1

# timeout counts as a network error
async def slow(url, **kw):
    await asyncio.sleep(1)
helpers._pyfetch = slow
await expect_err(fetch("http://x/slow", timeout=0.01, retries=0), "TimeoutError")
print("OK")
`,
  { allowNet: true },
);

pyTest(
  "fetch_many: order, partial failure, per-item options, concurrency cap",
  FAKE_NET + String.raw`
running = peak = 0
async def counting(url, **kw):
    global running, peak
    running += 1
    peak = max(peak, running)
    await asyncio.sleep(0.01)
    running -= 1
    return await fake_pyfetch(url, **kw)
helpers._pyfetch = counting

for i in range(6):
    script["http://x/%d" % i] = [FakeResp(200, _j.dumps({"i": i}))]
script["http://x/gone"] = [FakeResp(404, "missing")]

items = ["http://x/0", "http://x/gone", {"url": "http://x/1", "as_": "text"}, "http://x/nowhere"] + \
        ["http://x/%d" % i for i in range(2, 6)]
res = await fetch_many(items, limit=2, retries=0)
assert peak == 2, peak
assert [r["url"] for r in res] == [i if isinstance(i, str) else i["url"] for i in items]
assert res[0] == {"url": "http://x/0", "ok": True, "data": {"i": 0}}, res[0]
assert res[1]["ok"] is False and "HTTP 404" in res[1]["error"] and "missing" in res[1]["error"], res[1]
assert res[2] == {"url": "http://x/1", "ok": True, "data": '{"i": 1}'}, res[2]
assert res[3]["ok"] is False and "connection refused" in res[3]["error"], res[3]
assert all(r["ok"] for r in res[4:])
assert await fetch_many([]) == []
print("OK")
`,
  { allowNet: true },
);

pyTest(
  "fetch: writes are not replayed, usage errors fail fast, options are validated",
  FAKE_NET + String.raw`
async def expect_err(coro, *needles):
    try:
        await coro
    except HelperError as e:
        for n in needles:
            assert n in str(e), (n, str(e))
    else:
        raise AssertionError("no HelperError")

# POST: 5xx and network errors are never retried; method is inferred from the body
script["http://x/w"] = [FakeResp(503, "busy")]
calls.clear()
await expect_err(fetch("http://x/w", json={"a": 1}), "POST http://x/w -> HTTP 503")
assert len(calls) == 1 and calls[0][1]["method"] == "POST"
calls.clear()
await expect_err(fetch("http://x/unreachable", method="POST", data="x"), "network error after 1 attempt")
assert len(calls) == 1

# ... but 429 was rejected before processing, so it is retried
script["http://x/r"] = [FakeResp(429), FakeResp(200, "{}")]
calls.clear()
assert await fetch("http://x/r", json={}) == {}
assert len(calls) == 2

# idempotent PUT is retried on 5xx; the error message names the real method
script["http://x/put"] = [FakeResp(503), FakeResp(200, "not json")]
calls.clear()
await expect_err(fetch("http://x/put", method="put"), "PUT http://x/put: response is not valid JSON")
assert len(calls) == 2

await expect_err(fetch("http://x/j", method="GET", json={}), "cannot have a body")

# a usage error (not a network failure) is reported once, not retried as a "network error"
calls.clear()
async def broken(url, **kw):
    calls.append(url)
    raise TypeError("bad argument")
helpers._pyfetch = broken
await expect_err(fetch("http://x/t"), "request could not be sent", "TypeError: bad argument")
assert len(calls) == 1
helpers._pyfetch = fake_pyfetch

# options are validated instead of silently misbehaving
await expect_err(fetch("http://x/j", retries=-1), "retries must be")
await expect_err(fetch("http://x/j", timeout=0), "timeout must be")
try:
    await fetch_many(["http://x/j"], limit=0)
except HelperError as e:
    assert "limit must be" in str(e)
else:
    raise AssertionError("limit=0 accepted")

# form values with several entries are sent as repeated fields
script["http://x/f"] = [FakeResp(200, "1")]
calls.clear()
await fetch("http://x/f", data={"tag": ["a", "b"], "q": "z"})
assert calls[0][1]["body"] == "tag=a&tag=b&q=z", calls[0][1]["body"]

# a malformed item fails on its own; the other URLs still succeed
script["http://x/ok"] = [FakeResp(200, "[1]")]
res = await fetch_many(["http://x/ok", {"as_": "text"}, 42, {"url": "http://x/ok", "as_": "text"}])
assert [r["ok"] for r in res] == [True, False, False, True], res
assert "URL string or a dict with a 'url' key" in res[1]["error"] and "URL string" in res[2]["error"]
assert res[3]["data"] == "[1]"
print("OK")
`,
  { allowNet: true },
);

Deno.test({
  name: "net helpers work through the real pyfetch / requests path",
  permissions: PERMS,
  async fn() {
    const [r] = await runPython([String.raw`
url = "https://cdn.jsdelivr.net/npm/pyodide@314.0.7/package.json"
d = await fetch(url)
assert d["name"] == "pyodide", d
assert (await fetch(url, as_="text")).startswith("{")
assert len(await fetch(url, as_="bytes")) > 100

res = await fetch_many([url, url.replace("package.json", "no-such-file.json")], retries=0)
assert res[0]["ok"] and res[0]["data"]["name"] == "pyodide", res[0]
assert not res[1]["ok"] and "HTTP 404" in res[1]["error"], res[1]

import requests
assert requests.get(url).status_code == 200
print("OK")
`], { realNet: true });
    assert(r.ok, `${r.stdout}\n${r.stderr}`);
    assertStringIncludes(r.stdout, "OK");
  },
});

Deno.test({
  name: "load(df=True), peek and emit handle pandas DataFrames",
  permissions: PERMS,
  async fn() {
    const [r] = await runPython([String.raw`
import pandas as pd
import io, contextlib
save([{"a": i, "b": "x%d" % i} for i in range(50)], "/tmp/df.csv")
df = load("/tmp/df.csv", df=True)
assert isinstance(df, pd.DataFrame) and df.shape == (50, 2) and df["a"].dtype.kind == "i"
save(df, "/tmp/df.json")
assert load("/tmp/df.json")[3] == {"a": 3, "b": "x3"}
save(df.head(2), "/tmp/df.jsonl")
assert len(load("/tmp/df.jsonl", df=True)) == 2

def cap(fn, *a, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*a, **kw)
    return buf.getvalue()
import numpy as np
save([{"n": np.int64(3), "ok": np.bool_(True), "x": np.float64("nan"), "arr": np.arange(3)}], "/tmp/np.json")
assert load("/tmp/np.json") == [{"n": 3, "ok": True, "x": None, "arr": [0, 1, 2]}], open("/tmp/np.json").read()
assert '"total": 5' in cap(emit, {"total": np.int64(5)})
assert check(df, "df is ambiguous") is False and check(np.arange(3), "arr") is False
p = cap(peek, df, n=2)
assert p.startswith("DataFrame(rows=50, cols=2)") and "a:int64" in p and "b:" in p, p
e = cap(emit, df)
assert "[50 rows x 2 cols]" in e and "x49" in e and "x20" not in e, e
print("OK")
`]);
    assert(r.ok, `${r.stdout}\n${r.stderr}`);
    assertStringIncludes(r.stdout, "OK");
    assertEquals(r.stderr, "");
  },
});
