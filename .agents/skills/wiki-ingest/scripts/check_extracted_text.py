"""Flag obvious extraction damage; this does not replace checking the original."""

import argparse
from pathlib import Path
import re
import sys


def check_text(text):
    issues = []
    if not text.strip():
        return ["Empty extraction: inspect the original and record this limitation."]
    if "\ufffd" in text or "\x00" in text:
        issues.append("Replacement or null characters: check text decoding.")
    run = []
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            fenced = not fenced
            run = []
            continue
        if fenced:
            continue
        if not stripped:
            # Bad PDF extracts often alternate a word with a whitespace-only line.
            continue
        if stripped.startswith(("#", "|", "- ", "* ", "> ", "![")):
            run = []
            continue
        words = re.findall(r"\S+", stripped)
        if len(words) <= 3 and len(stripped) <= 35:
            run.append(number)
            if len(run) == 10:
                issues.append(
                    f"Lines {run[0]}-{number}: ten short lines in a row; "
                    "check for words or formula indices split onto separate lines."
                )
        else:
            run = []
    for name in ("sub", "sup"):
        if text.count(f"<{name}>") != text.count(f"</{name}>"):
            issues.append(f"Unbalanced <{name}> tags.")
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    failed = False
    for path in args.files:
        try:
            issues = check_text(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError) as error:
            issues = [str(error)]
        print(path)
        for issue in issues:
            print(f"  CHECK: {issue}")
        if issues:
            failed = True
        else:
            print("  OK: no obvious extraction damage; original still needs review.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
