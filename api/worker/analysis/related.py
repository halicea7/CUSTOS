"""Related code for the verification pass: where a finding's names are defined or used.

A claim is often disproved somewhere else: a check in the caller, the function
that reads a value back, a validator in another file. The second review only
sees the lines around the finding, so each candidate gets a few short excerpts
from the rest of the checkout where the names it's about appear.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass

from worker.analysis.sast import RawFinding
from worker.analysis.vetting import TEST_PATH

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{3,60}$")
_BACKTICKED = re.compile(r"`([^`\n]{4,80})`")
_CALL = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]{3,60})\s*\(")
_ENCLOSING = re.compile(r"^\s*(?:async\s+)?def\s+(\w+)|^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)"
                        r"|^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(")
# Names too common to tell anything apart.
_GENERIC = {
    "self", "this", "true", "false", "none", "null", "return", "await", "async", "print", "open", "range",
    "list", "dict", "tuple", "isinstance", "getattr", "setattr", "hasattr", "super", "format", "join",
    "split", "strip", "append", "extend", "update", "items", "keys", "values", "lower", "upper", "replace",
    "request", "response", "result", "value", "data", "json", "text", "body", "query", "params", "args",
    "kwargs", "config", "settings", "string", "number", "object", "error", "exception", "logger", "info",
    "warning", "debug", "main", "init", "__init__", "test", "func", "function", "callback", "then",
    "catch", "fetch", "get", "post", "patch", "delete", "send", "read", "write", "close", "select",
    "where", "execute", "commit", "filter", "lambda", "yield", "import", "from", "class", "const",
}
_CONTEXT = 5              # lines around each hit
_MAX_NAMES = 6            # per finding
_MAX_EXCERPTS = 5         # per finding
_MAX_HITS_PER_NAME = 60   # per name; the files the review chose are searched first
_OWN_WINDOW = 25          # the verification prompt already shows this many lines around the finding
_DOCS = (".md", ".rst", ".txt", ".adoc")
_IMPORT = re.compile(r"^\s*(?:from\s+\S+\s+import|import)\b|^\s*}?\s*from\s+['\"]")   # prose mentions a name; it doesn't decide anything


@dataclass
class Excerpt:
    path: str
    start: int
    lines: list[str]
    name: str
    definition: bool


def names_for(f: RawFinding, content: str | None) -> list[str]:
    """The identifiers a finding is about, most telling first."""
    found: list[str] = []

    def add(name: str | None) -> None:
        name = (name or "").strip().rstrip("()").split(".")[-1]
        if _IDENT.match(name) and name.lower() not in _GENERIC and name not in found:
            found.append(name)

    for text in (f.title, f.description, f.llm_reasoning):
        for m in _BACKTICKED.finditer(text or ""):
            add(m.group(1))
    lines = (content or "").split("\n")
    if f.line_start and lines:
        for line in reversed(lines[:f.line_start]):          # the function the finding sits in
            if m := _ENCLOSING.match(line):
                add(next(g for g in m.groups() if g))
                break
        for line in lines[f.line_start - 1:(f.line_end or f.line_start)]:
            for m in _CALL.finditer(line):
                add(m.group(1))
    return found[:_MAX_NAMES]


def _is_definition(line: str, name: str) -> bool:
    n = re.escape(name)
    # Not "name: type" annotations (schema fields): they say nothing about behaviour.
    return bool(re.search(rf"\b(?:def|class|function)\s+{n}\b|\b(?:const|let|var)\s+{n}\b|^\s*{n}\s*=(?!=)", line))


def find_related(items: list[RawFinding], files: Iterable[tuple[str, str]],
                 own: dict[str, str]) -> dict[int, list[Excerpt]]:
    """Excerpts per finding (keyed by id(finding)) from *files*, the checkout's readable files.

    *own* holds the files the findings are in, to pick out their names.
    """
    wanted = {id(f): names_for(f, own.get(f.file_path or "")) for f in items}
    all_names = {n for names in wanted.values() for n in names}
    if not all_names:
        return {}
    pattern = re.compile(r"\b(" + "|".join(sorted(map(re.escape, all_names), key=len, reverse=True)) + r")\b")
    hits: dict[str, list[tuple[str, int, list[str], bool]]] = {n: [] for n in all_names}
    for path, content in files:
        if path.lower().endswith(_DOCS) or not any(n in content for n in all_names):
            continue
        lines = content.split("\n")
        for i, line in enumerate(lines, 1):
            if _IMPORT.match(line):
                continue            # an import says nothing about behaviour
            for m in pattern.finditer(line):
                bucket = hits[m.group(1)]
                if len(bucket) <= _MAX_HITS_PER_NAME:
                    bucket.append((path, i, lines, _is_definition(line, m.group(1))))
    out: dict[int, list[Excerpt]] = {}
    for f in items:
        chosen: list[Excerpt] = []
        for name in wanted[id(f)]:
            # Definitions first, then uses elsewhere in the finding's own file (callers and the
            # checks around them usually live there), then other files, tests last.
            ranked = sorted(hits[name], key=lambda h: (not h[3], h[0] != f.file_path, bool(TEST_PATH.search(h[0]))))
            picked_def = picked_use = False      # per name: its definition and one use
            for path, line_no, lines, is_def in ranked:
                if (picked_def if is_def else picked_use) or len(chosen) >= _MAX_EXCERPTS:
                    continue
                if path == f.file_path and f.line_start and abs(line_no - f.line_start) <= _OWN_WINDOW:
                    continue        # already in the prompt
                if any(e.path == path and abs(e.start + _CONTEXT - line_no) <= _CONTEXT * 2 for e in chosen):
                    continue        # overlaps an excerpt we have
                start = max(1, line_no - _CONTEXT)
                chosen.append(Excerpt(path, start, lines[start - 1:line_no + _CONTEXT], name, is_def))
                picked_def, picked_use = picked_def or is_def, picked_use or not is_def
            if len(chosen) >= _MAX_EXCERPTS:
                break
        if chosen:
            out[id(f)] = chosen
    return out


def render(excerpts: list[Excerpt]) -> str:
    blocks = []
    for e in excerpts:
        code = "\n".join(f"{n:>5}| {line}" for n, line in enumerate(e.lines, e.start))
        what = "where it's defined" if e.definition else "where it's used"
        blocks.append(f"`{e.name}`, {what} ({e.path}, lines {e.start}-{e.start + len(e.lines) - 1}):\n{code}")
    return "\n\n".join(blocks)
