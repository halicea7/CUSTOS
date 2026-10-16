"""Related code for the verification pass."""

import os

from worker.analysis import related, vetting
from worker.analysis.llm import _readable_files
from worker.analysis.sast import RawFinding

STORE = "\n".join([
    "from app.crypto import seal",
    "",
    "def store_key(db, key, url):",
    "    db['key'] = seal(key)",
    "    db['origin'] = origin_of(url)",
] + ["# filler"] * 40 + [
    "def update(db, body):",
    "    saved = db.get('origin')",
    "    if body.key is None and saved and origin_of(body.base_url) != saved:",
    "        raise ValueError('re-enter the key for a new host')",
    "    if body.key is not None:",
    "        store_key(db, body.key, body.base_url)",
])
LOAD = "def origin_of(url):\n    return url.split('/')[2]\n\ndef key_for(db, url):\n    return db['key'] if db.get('origin') == origin_of(url) else ''\n"


def _claim():
    return RawFinding("llm", "high", "Saved key can be redirected to another host", file_path="app/store.py",
                      line_start=3, line_end=5,
                      description="`store_key` saves the key without re-checking the origin, so changing `base_url` sends it elsewhere.")


def test_names_come_from_the_claim_the_enclosing_function_and_calls():
    names = related.names_for(_claim(), STORE)
    assert names[:2] == ["store_key", "base_url"] and "seal" in names and "origin_of" in names
    assert "self" not in names and "db" not in names


def test_definitions_and_far_away_uses_are_found_but_not_docs_imports_or_the_lines_already_shown():
    f = _claim()
    files = [("app/store.py", STORE), ("app/load.py", LOAD), ("README.md", "Set `store_key` and `base_url`.\n"),
             ("app/crypto.py", "def seal(v):\n    return v[::-1]\n")]
    out = related.find_related([f], files, {"app/store.py": STORE})[id(f)]
    got = {(e.name, e.path, e.definition) for e in out}
    assert ("store_key", "app/store.py", False) in got          # the caller, 45 lines down (with the
    # origin check next to it, so base_url's use there isn't added a second time)
    assert not any(e.name == "base_url" and e.path == "app/store.py" for e in out)
    assert ("seal", "app/crypto.py", True) in got
    assert not any(e.path == "README.md" for e in out)
    text = related.render(out)
    assert "re-enter the key for a new host" in text and "from app.crypto import seal" not in text


def test_verify_prompt_adds_related_code_within_a_budget(monkeypatch):
    f = _claim()
    rel = related.find_related([f], [("app/store.py", STORE), ("app/load.py", LOAD)], {"app/store.py": STORE})
    assert "Related code elsewhere in the repository:" in vetting.verify_prompt([f], {"app/store.py": STORE}, rel)
    monkeypatch.setattr(vetting, "MAX_RELATED_CHARS", 10)
    assert "Related code" not in vetting.verify_prompt([f], {"app/store.py": STORE}, rel)


def test_readable_files_skip_secrets_symlinks_and_virtualenvs_and_start_with_the_chosen_files(tmp_path):
    for rel, text in {"app/a.py": "a", "app/b.py": "b", ".env": "SECRET=1", ".venv-tools/lib/x.py": "x",
                      "vendor/y.py": "y", "id_rsa": "key"}.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text)
    os.symlink("/etc/hosts", tmp_path / "app" / "link.py")
    got = [p for p, _ in _readable_files(str(tmp_path), 10_000, first={"app/b.py": "b"})]
    assert got == ["app/b.py", "app/a.py"]
