import os
import sys
import json
import argparse
from typing import Any, Dict

# Import functions from FastAPI app module
from app.main import (
    get_repo_metadata,
    stack_detect,
    get_repo_languages,
    get_repo_languages_detail,
    get_contributors,
    get_health,
    static_analysis,
)


def analyze_repo(full_name: str) -> Dict[str, Any]:
    try:
        owner, name = full_name.split('/', 1)
    except ValueError:
        raise SystemExit("Repo must be in the form 'owner/name'")

    # Call underlying endpoint functions directly
    meta = get_repo_metadata(owner, name)
    stack = stack_detect(owner, name)
    langs = get_repo_languages(owner, name)
    try:
        langs_detail = get_repo_languages_detail(owner, name)
    except Exception:
        langs_detail = {}
    contrib = get_contributors(owner, name)
    health = get_health(owner, name)
    try:
        analysis = static_analysis(owner, name, max_files=600, clone_timeout=120)
    except Exception as e:
        analysis = {"error": str(e)}

    summary = {
        "metadata": meta.model_dump() if hasattr(meta, 'model_dump') else meta,
        "stack": stack.model_dump() if hasattr(stack, 'model_dump') else stack,
        "languages": langs,
        "languages_detail": langs_detail,
        "contributors": (contrib.model_dump() if hasattr(contrib, 'model_dump') else contrib),
        "health": (health.model_dump() if hasattr(health, 'model_dump') else health),
        "analysis": (analysis.model_dump() if hasattr(analysis, 'model_dump') else analysis),
    }
    return summary


def main():
    parser = argparse.ArgumentParser(description="GitHub Repo Analyzer CLI (offline, calls analysis routines directly)")
    parser.add_argument("repo", help="GitHub repository full name, e.g. owner/name")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = parser.parse_args()

    data = analyze_repo(args.repo)
    if args.pretty:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(data, separators=(",",":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
