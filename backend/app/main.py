from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Optional, List
from github import Github
from github.GithubException import GithubException
import httpx
import base64
import os
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
import subprocess
import tempfile
import shutil
import json
import re
import sys
import shutil as _shutil
from pathlib import Path

# Load env from a root .env if present
load_dotenv()

app = FastAPI(title="GitHub Repo Analyzer API", version="0.1.0")

# CORS for local dev and Render frontend
# Configure via FRONTEND_ORIGIN; supports comma-separated list.
# Fallback to wildcard in development.
origins_env = os.getenv("FRONTEND_ORIGIN", "").strip()
if origins_env:
    allow_origins = [o.strip() for o in origins_env.split(",") if o.strip()]
else:
    allow_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _check_tool(args: List[str]) -> dict:
    try:
        code, out, err = _run(args, timeout=8)
        return {"ok": code == 0, "stdout": (out or "").strip(), "stderr": (err or "").strip()}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.get("/api/debug/env-tools")
def debug_env_tools():
    """Quick environment check for optional analyzers (disabled by default)."""
    if os.getenv("ENABLE_DEBUG", "0") != "1":
        raise HTTPException(status_code=404, detail="Not found")
    return {
        "git": _check_tool(["git", "--version"]),
        "node": _check_tool(["node", "-v"]),
        "npx": _check_tool(["npx", "-v"]),
        "eslint": _check_tool(["npx", "--yes", "eslint", "-v"]),
        "plato": _check_tool(["npx", "--yes", "plato", "-V"]),
        "golangci_lint": _check_tool(["golangci-lint", "version"]),
        "java": _check_tool(["java", "-version"]),
        "dotnet": _check_tool(["dotnet", "--version"]),
        "php": _check_tool(["php", "-v"]),
        "phpstan": _check_tool(["phpstan", "--version"]),
        "phpcs": _check_tool(["phpcs", "--version"]),
        "rubocop": _check_tool(["rubocop", "-v"]),
    }

def gh_client() -> Github:
    token = os.getenv("GITHUB_TOKEN")
    # Configure a network timeout to avoid hanging requests
    if token:
        return Github(token, timeout=10)
    return Github(timeout=10)  # unauthenticated, lower rate limit


# Simple in-memory caches (best-effort; resets on process restart)
_STACK_CACHE: dict[str, dict] = {}
_ANALYSIS_CACHE: dict[str, dict] = {}
_HOTSPOT_CACHE: dict[str, dict] = {}
_ARCH_CACHE: dict[str, dict] = {}
_CACHE_LIMIT = 64

def _cache_set(cache: dict, key: str, value: dict):
    try:
        if key in cache:
            cache.pop(key, None)
        cache[key] = value
        # Evict oldest
        if len(cache) > _CACHE_LIMIT:
            first = next(iter(cache))
            cache.pop(first, None)
    except Exception:
        pass

def _cache_get(cache: dict, key: str) -> Optional[dict]:
    try:
        val = cache.get(key)
        if val is not None:
            # touch to make most-recent
            cache.pop(key, None)
            cache[key] = val
        return val
    except Exception:
        return None


class RepoMetadata(BaseModel):
    full_name: str
    description: Optional[str]
    stars: int
    forks: int
    open_issues: int
    license: Optional[str]
    default_branch: str
    last_commit_sha: Optional[str]
    last_pushed_at: Optional[str]
    homepage: Optional[str]
    topics: List[str] = []


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/")
def root():
    return {"message": "GitHub Repo Analyzer API"}


@app.get("/api/debug/github-rate-limit")
def github_rate_limit():
    if os.getenv("ENABLE_DEBUG", "0") != "1":
        raise HTTPException(status_code=404, detail="Not found")
    headers = {"Accept": "application/vnd.github+json"}
    token = os.getenv("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with httpx.Client(timeout=6.0, follow_redirects=True) as client:
            resp = client.get("https://api.github.com/rate_limit", headers=headers)
            return {"status_code": resp.status_code, "body": resp.json() if resp.headers.get("content-type","" ).startswith("application/json") else resp.text}
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout reaching api.github.com (rate_limit)")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error reaching api.github.com: {e}")


@app.get("/api/repo/{owner}/{name}/metadata", response_model=RepoMetadata)
def get_repo_metadata(owner: str, name: str):
    try:
        # Fast path via GitHub REST API with strict timeout
        headers = {
            "Accept": "application/vnd.github+json",
        }
        token = os.getenv("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            repo_resp = client.get(f"https://api.github.com/repos/{owner}/{name}", headers=headers)
            if repo_resp.status_code == 403:
                raise HTTPException(status_code=429, detail="GitHub API rate limited. Set GITHUB_TOKEN and retry.")
            if repo_resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Repository not found.")
            repo_resp.raise_for_status()
            r = repo_resp.json()

            default_branch = r.get("default_branch", "main")
            last_commit_sha = None
            try:
                br_resp = client.get(f"https://api.github.com/repos/{owner}/{name}/branches/{default_branch}", headers=headers)
                if br_resp.status_code == 200:
                    last_commit_sha = br_resp.json().get("commit", {}).get("sha")
            except Exception:
                pass

            license_name = None
            lic = r.get("license") or {}
            if isinstance(lic, dict):
                license_name = lic.get("spdx_id") or lic.get("name")

            # Topics: include default Accept is often enough now
            topics = r.get("topics") or []

            pushed_at = r.get("pushed_at")
            return RepoMetadata(
                full_name=r.get("full_name", f"{owner}/{name}"),
                description=r.get("description"),
                stars=r.get("stargazers_count", 0),
                forks=r.get("forks_count", 0),
                open_issues=r.get("open_issues_count", 0),
                license=license_name,
                default_branch=default_branch,
                last_commit_sha=last_commit_sha,
                last_pushed_at=pushed_at,
                homepage=r.get("homepage"),
                topics=topics,
            )
    except httpx.TimeoutException:
        # Fallback to PyGithub on timeout
        try:
            gh = gh_client()
            repo = gh.get_repo(f"{owner}/{name}")
            last_commit_sha = None
            try:
                last_commit_sha = repo.get_branch(repo.default_branch).commit.sha
            except Exception:
                pass
            license_name = None
            try:
                lic = repo.get_license()
                license_name = lic.license.spdx_id or lic.license.name
            except Exception:
                license_name = None
            return RepoMetadata(
                full_name=repo.full_name,
                description=repo.description,
                stars=repo.stargazers_count,
                forks=repo.forks_count,
                open_issues=repo.open_issues_count,
                license=license_name,
                default_branch=repo.default_branch,
                last_commit_sha=last_commit_sha,
                last_pushed_at=repo.pushed_at.isoformat() if repo.pushed_at else None,
                homepage=repo.homepage,
                topics=list(repo.get_topics() or []),
            )
        except GithubException as ge:
            if ge.status == 403:
                raise HTTPException(status_code=429, detail="GitHub API rate limited. Set GITHUB_TOKEN and retry.")
            raise HTTPException(status_code=ge.status or 500, detail=str(ge))
        except Exception as e:
            raise HTTPException(status_code=504, detail=f"GitHub API timeout and fallback failed: {e}")
    except HTTPException:
        raise
    except GithubException as ge:
        # Provide clearer guidance on rate limits and repo access
        if ge.status == 403:
            raise HTTPException(status_code=429, detail="GitHub API rate limited. Set GITHUB_TOKEN and retry.")
        raise HTTPException(status_code=ge.status or 500, detail=ge.data.get('message') if hasattr(ge, 'data') and isinstance(ge.data, dict) else str(ge))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")


# ----------------------------
# Related repos and author's other repos
# ----------------------------

def _repo_summary(item: dict) -> dict:
    return {
        "full_name": item.get("full_name"),
        "description": item.get("description"),
        "stars": item.get("stargazers_count", 0),
        "language": item.get("language"),
        "html_url": item.get("html_url"),
    }


@app.get("/api/repo/{owner}/{name}/related")
def related_repos(owner: str, name: str, limit: int = 5):
    """Return up to `limit` related repositories based on primary language and topics.

    Heuristic:
    - Fetch repo to get primary language and topics.
    - Search for repos in the same language, optionally boosting by matching one topic.
    - Sort by stars, exclude the current repo, return top N.
    """
    try:
        headers = _gh_headers()
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            repo_resp = client.get(f"https://api.github.com/repos/{owner}/{name}", headers=headers)
            if repo_resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Repository not found.")
            if repo_resp.status_code == 403:
                raise HTTPException(status_code=429, detail="GitHub API rate limited. Set GITHUB_TOKEN and retry.")
            repo_resp.raise_for_status()
            r = repo_resp.json()
            primary_lang = r.get("language")
            topics = r.get("topics") or []

            # Build a conservative search query
            q_parts = []
            if primary_lang:
                q_parts.append(f"language:{primary_lang}")
            # add one topic if available to improve relevance
            if topics:
                q_parts.append(f"topic:{topics[0]}")
            # Avoid forks preference reduces noise
            q_parts.append("fork:false")
            q = "+".join([p.replace(" ", "+") for p in q_parts]) or "stars:>100"

            search_url = f"https://api.github.com/search/repositories?q={q}&sort=stars&order=desc&per_page={min(max(limit*2, 10), 50)}"
            s = client.get(search_url, headers=headers)
            if s.status_code == 403:
                raise HTTPException(status_code=429, detail="GitHub API rate limited. Set GITHUB_TOKEN and retry.")
            s.raise_for_status()
            items = s.json().get("items", [])

            out = []
            for it in items:
                if it.get("full_name", "").lower() == f"{owner}/{name}".lower():
                    continue
                out.append(_repo_summary(it))
                if len(out) >= limit:
                    break
            return out
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout fetching related repositories")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch related repositories: {e}")


@app.get("/api/repo/{owner}/{name}/author-repos")
def author_repos(owner: str, name: str, limit: int = 5):
    """Return up to `limit` other repositories from the same owner sorted by stars.

    Excludes the current repository.
    """
    try:
        headers = _gh_headers()
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            # Determine owner type (user or org)
            user_resp = client.get(f"https://api.github.com/users/{owner}", headers=headers)
            if user_resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Owner not found")
            user_resp.raise_for_status()
            user_data = user_resp.json()
            is_org = user_data.get("type") == "Organization"

            # List repos for user/org
            base_url = f"https://api.github.com/{'orgs' if is_org else 'users'}/{owner}/repos"
            # Get first page with enough items to select top by stars
            list_url = f"{base_url}?per_page=100&type=public&sort=updated"
            r = client.get(list_url, headers=headers)
            if r.status_code == 403:
                raise HTTPException(status_code=429, detail="GitHub API rate limited. Set GITHUB_TOKEN and retry.")
            r.raise_for_status()
            arr = r.json() or []
            # Sort by stargazers_count desc, exclude the current repo
            arr = [a for a in arr if a.get("full_name", "").lower() != f"{owner}/{name}".lower()]
            arr.sort(key=lambda x: x.get("stargazers_count", 0), reverse=True)
            out = [_repo_summary(it) for it in arr[:limit]]
            return out
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout fetching author's repositories")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch author's repositories: {e}")


# ----------------------------
# Languages detail (files, lines) via shallow clone
# ----------------------------

def _ext_to_lang(p: Path) -> str | None:
    ext = p.suffix.lower()
    # A lightweight map for common languages; extend as needed
    m = {
        ".py": "Python",
        ".js": "JavaScript",
        ".mjs": "JavaScript",
        ".cjs": "JavaScript",
        ".jsx": "JavaScript",
        ".ts": "TypeScript",
        ".tsx": "TypeScript",
        ".d.ts": "TypeScript",
        ".mts": "TypeScript",
        ".cts": "TypeScript",
        ".go": "Go",
        ".java": "Java",
        ".cs": "C#",
        ".php": "PHP",
        ".rb": "Ruby",
        ".rs": "Rust",
        ".c": "C",
        ".h": "C",
        ".cpp": "C++",
        ".cc": "C++",
        ".cxx": "C++",
        ".hpp": "C++",
        ".m": "Objective-C",
        ".mm": "Objective-C++",
        ".kt": "Kotlin",
        ".swift": "Swift",
        ".scala": "Scala",
        ".r": "R",
        ".hs": "Haskell",
        ".sh": "Shell",
        ".ps1": "PowerShell",
        ".lua": "Lua",
        ".dart": "Dart",
        ".erl": "Erlang",
        ".ex": "Elixir",
        ".exs": "Elixir",
        ".pl": "Perl",
        ".pm": "Perl",
        ".groovy": "Groovy",
        ".vb": "Visual Basic",
        ".fs": "F#",
        ".fsharp": "F#",
        ".html": "HTML",
        ".htm": "HTML",
        ".hbs": "Handlebars",
        ".handlebars": "Handlebars",
    }
    return m.get(ext)


@app.get("/api/repo/{owner}/{name}/languages-detail")
def get_repo_languages_detail(owner: str, name: str):
    """Return per-language file and line counts. Best-effort and capped.

    Response format: { "Python": {"files": 12, "lines": 3456}, ... }
    """
    try:
        # Caps and timeouts to keep things snappy
        max_files = 4000
        clone_timeout = 90
        read_max_bytes = 2_000_000  # skip files larger than ~2MB to avoid heavy reads

        with tempfile.TemporaryDirectory() as tmpdir:
            repo_url = f"https://github.com/{owner}/{name}.git"
            code, out, err = _run([
                "git", "clone", "--depth", "1", "--no-single-branch", repo_url, tmpdir
            ], timeout=clone_timeout)
            if code != 0:
                raise HTTPException(status_code=502, detail=f"git clone failed: {err or out}")

            counts: dict[str, dict[str, int]] = {}
            seen = 0
            for root, dirs, files in os.walk(tmpdir):
                # Trim large directories if needed
                for fn in files:
                    if seen >= max_files:
                        break
                    seen += 1
                    p = Path(root) / fn
                    if not p.is_file():
                        continue
                    # Skip vendored/large artifacts
                    if any(seg.lower() in {".git", "node_modules", "dist", "build", "target", "bin", ".next", ".venv"} for seg in p.parts):
                        continue
                    try:
                        lang = _ext_to_lang(p)
                        if not lang:
                            continue
                        # Skip very large files
                        try:
                            if p.stat().st_size > read_max_bytes:
                                # Count as a file but don't read lines
                                d = counts.setdefault(lang, {"files": 0, "lines": 0})
                                d["files"] += 1
                                continue
                        except Exception:
                            pass
                        # Read as text and count lines quickly
                        lines = 0
                        with open(p, "rb") as f:
                            for chunk in f:
                                # Count newlines in binary-safe way
                                lines += chunk.count(b"\n")
                        d = counts.setdefault(lang, {"files": 0, "lines": 0})
                        d["files"] += 1
                        d["lines"] += int(lines)
                    except Exception:
                        # best-effort; ignore file on error
                        continue

            return counts
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"languages-detail failed: {e}")


# ----------------------------
# Stack Detection
# ----------------------------

class StackDetectResponse(BaseModel):
    languages: List[str] = []
    runtime: List[str] = []
    frameworks: List[str] = []
    packaging: List[str] = []
    containers: List[str] = []
    ci: List[str] = []
    tests: List[str] = []


def _gh_headers() -> dict:
    headers = {"Accept": "application/vnd.github+json"}
    token = os.getenv("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _fetch_repo_text_file(owner: str, name: str, path: str, timeout: float = 8.0) -> Optional[str]:
    url = f"https://api.github.com/repos/{owner}/{name}/contents/{path}"
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            r = client.get(url, headers=_gh_headers())
            if r.status_code == 404:
                return None
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and data.get("encoding") == "base64" and data.get("content"):
                return base64.b64decode(data["content"]).decode("utf-8", errors="ignore")
            # If it's a directory or other, ignore
            return None
    except Exception:
        return None


def _list_repo_dir(owner: str, name: str, path: str, timeout: float = 8.0) -> List[str]:
    url = f"https://api.github.com/repos/{owner}/{name}/contents/{path}"
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            r = client.get(url, headers=_gh_headers())
            if r.status_code != 200:
                return []
            arr = r.json() or []
            out: List[str] = []
            for it in arr:
                if isinstance(it, dict) and it.get("type") in ("file", "dir") and it.get("name"):
                    out.append(it["name"])
            return out
    except Exception:
        return []


@app.get("/api/repo/{owner}/{name}/stack-detect", response_model=StackDetectResponse)
def stack_detect(owner: str, name: str):
    key = f"{owner}/{name}"
    cached = _cache_get(_STACK_CACHE, key)
    if cached:
        return StackDetectResponse(**cached)

    try:
        langs = []
        runtime = []
        frameworks = []
        packaging = []
        containers = []
        ci = []
        tests = []

        # Read common files
        req = _fetch_repo_text_file(owner, name, "requirements.txt")
        pyproj = _fetch_repo_text_file(owner, name, "pyproject.toml")
        pkg = _fetch_repo_text_file(owner, name, "package.json")
        dockerfile = _fetch_repo_text_file(owner, name, "Dockerfile")
        devcontainer = _fetch_repo_text_file(owner, name, ".devcontainer/devcontainer.json")

        # Detect from requirements/pyproject
        py_text = "\n".join([t for t in [req, pyproj] if t])
        if py_text:
            langs.append("python")
            runtime.append("python")
            if re.search(r"fastapi\b", py_text, re.I): frameworks.append("fastapi")
            if re.search(r"django\b", py_text, re.I): frameworks.append("django")
            if re.search(r"flask\b", py_text, re.I): frameworks.append("flask")
            if re.search(r"pytest\b", py_text, re.I): tests.append("pytest")
            if re.search(r"poetry\b|build-system\s*=\s*\{.*poetry", pyproj or "", re.I | re.S): packaging.append("poetry")

        # Detect from package.json
        if pkg:
            try:
                pj = json.loads(pkg)
            except Exception:
                pj = {}
            if pj:
                langs.append("javascript")
                if "typescript" in (pj.get("devDependencies", {}) | pj.get("dependencies", {})): langs.append("typescript")
                runtime.append("node")
                deps = {**(pj.get("dependencies", {}) or {}), **(pj.get("devDependencies", {}) or {})}
                if any(k in deps for k in ["react", "react-dom"]): frameworks.append("react")
                if any(k in deps for k in ["next", "nextjs"]): frameworks.append("nextjs")
                if "vite" in deps: packaging.append("vite")
                if any(k in deps for k in ["jest", "vitest"]): tests.extend([k for k in ["jest", "vitest"] if k in deps])
                if any(k in deps for k in ["eslint", "prettier"]): packaging.extend([k for k in ["eslint", "prettier"] if k in deps])

        # Docker / devcontainer
        if dockerfile:
            containers.append("docker")
            if re.search(r"FROM\s+python", dockerfile, re.I): runtime.append("python")
            if re.search(r"FROM\s+node", dockerfile, re.I): runtime.append("node")
        if devcontainer:
            containers.append("devcontainer")

        # CI providers
        gh_wf = _list_repo_dir(owner, name, ".github/workflows")
        if gh_wf:
            ci.append("github_actions")

        # Deduplicate, stable order
        def dedup(seq: List[str]) -> List[str]:
            out = []
            seen = set()
            for s in seq:
                if s and s not in seen:
                    seen.add(s); out.append(s)
            return out

        resp = StackDetectResponse(
            languages=dedup(langs),
            runtime=dedup(runtime),
            frameworks=dedup(frameworks),
            packaging=dedup(packaging),
            containers=dedup(containers),
            ci=dedup(ci),
            tests=dedup(tests),
        )
        _cache_set(_STACK_CACHE, key, resp.model_dump())
        return resp
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout detecting stack")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Stack detection failed: {e}")


# ----------------------------
# Tech Radar (multi-repo aggregation)
# ----------------------------

class TechRadarRequest(BaseModel):
    repos: List[str]  # ["owner/name", ...]


class TechRadarResponse(BaseModel):
    languages: Dict[str, int] = {}
    runtime: Dict[str, int] = {}
    frameworks: Dict[str, int] = {}
    packaging: Dict[str, int] = {}
    containers: Dict[str, int] = {}
    ci: Dict[str, int] = {}
    tests: Dict[str, int] = {}


@app.post("/api/tech-radar", response_model=TechRadarResponse)
def tech_radar(body: TechRadarRequest):
    try:
        buckets = {
            "languages": {},
            "runtime": {},
            "frameworks": {},
            "packaging": {},
            "containers": {},
            "ci": {},
            "tests": {},
        }
        seen: set[str] = set()
        for full in body.repos or []:
            if not full or "/" not in full:
                continue
            if full in seen:
                continue
            seen.add(full)
            owner, name = full.split("/", 1)
            try:
                sd = stack_detect(owner, name)
                # For each category, increment counts for unique items per repo
                for cat in buckets.keys():
                    vals = getattr(sd, cat, []) or []
                    uniq = set([v.lower() for v in vals if v])
                    for v in uniq:
                        buckets[cat][v] = buckets[cat].get(v, 0) + 1
            except Exception:
                # best-effort; skip on error and continue
                continue
        return TechRadarResponse(**buckets)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tech radar aggregation failed: {e}")


@app.get("/api/repo/{owner}/{name}/languages")
def get_repo_languages(owner: str, name: str) -> Dict[str, int]:
    try:
        headers = {"Accept": "application/vnd.github+json"}
        token = os.getenv("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            resp = client.get(f"https://api.github.com/repos/{owner}/{name}/languages", headers=headers)
            if resp.status_code == 403:
                raise HTTPException(status_code=429, detail="GitHub API rate limited. Set GITHUB_TOKEN and retry.")
            if resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Repository not found.")
            resp.raise_for_status()
            return resp.json() or {}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")


class ReadmeMap(BaseModel):
    headings: List[str]
    mermaid: str


class ReadmeLink(BaseModel):
    text: str
    url: str


class ReadmeCode(BaseModel):
    lang: Optional[str] = None
    content: str


class ReadmeBadge(BaseModel):
    alt: Optional[str] = None
    image: str
    href: Optional[str] = None


class ReadmeNode(BaseModel):
    id: str
    level: int
    title: str
    slug: str
    url: str
    snippet: Optional[str] = None
    markdown: Optional[str] = None
    links: List[ReadmeLink] = []
    code: Optional[ReadmeCode] = None
    badges: List[ReadmeBadge] = []
    children: List['ReadmeNode'] = []

ReadmeNode.update_forward_refs()


@app.get("/api/repo/{owner}/{name}/readme-map", response_model=ReadmeMap)
def get_readme_map(owner: str, name: str):
    try:
        gh = gh_client()
        repo = gh.get_repo(f"{owner}/{name}")
        readme = repo.get_readme()
        content = base64.b64decode(readme.content).decode("utf-8", errors="ignore")
        # parse headings with levels
        raw_headings: List[tuple[int, str]] = []
        for line in content.splitlines():
            line = line.rstrip()
            if line.startswith("#"):
                level = len(line) - len(line.lstrip('#'))
                clean = line.lstrip('#').strip()
                if clean:
                    raw_headings.append((level, clean))

        # sanitize headings for Mermaid labels
        import re
        def sanitize(text: str) -> str:
            t = text
            # remove images ![alt](url)
            t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", t)
            # replace markdown links [label](url) -> label
            t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
            # strip inline code backticks
            t = t.replace("`", "")
            # remove angle brackets that can confuse parser
            t = t.replace("<", "").replace(">", "")
            # collapse whitespace
            t = re.sub(r"\s+", " ", t).strip()
            # limit length
            if len(t) > 60:
                t = t[:57] + "..."
            # remove stray brackets/parentheses that break Mermaid labels
            t = t.replace("[", "(").replace("]", ")").replace("{", "(").replace("}", ")")
            # replace double quotes as we wrap labels in quotes
            t = t.replace('"', "'")
            return t

        # sanitize and drop empty results
        cleaned: List[tuple[int, str]] = []
        for lvl, h in raw_headings:
            s = sanitize(h)
            if s:
                cleaned.append((lvl, s))
        # limit to avoid clutter
        cleaned = cleaned[:12]
        clean_headings = [h for _, h in cleaned]

        # generate simple mermaid flow from common headings (vertical for readability)
        nodes = []
        edges = []
        def node_id(i: int):
            return chr(65 + i)  # A, B, C...

        def wrap_label(s: str, width: int = 22) -> str:
            # Insert <br/> every ~width characters at whitespace boundaries
            if len(s) <= width:
                return s
            parts = []
            line = []
            count = 0
            for word in s.split(' '):
                if count + len(word) + (1 if line else 0) > width:
                    parts.append(' '.join(line))
                    line = [word]
                    count = len(word)
                else:
                    line.append(word)
                    count += len(word) + (1 if line[:-1] else 0)
            if line:
                parts.append(' '.join(line))
            return '<br/>'.join(parts)

        # build a hierarchical tree using a simple stack of last nodes per level
        id_stack: dict[int, str] = {}
        for i, (lvl, h) in enumerate(cleaned):
            nid = node_id(i)
            label = wrap_label(h if h else f"Section {i+1}", 26)
            nodes.append(f"  {nid}[\"{label}\"]:::heading")
            id_stack[lvl] = nid
            # connect to nearest parent with lower level
            parent = None
            for pl in range(lvl - 1, 0, -1):
                if pl in id_stack:
                    parent = id_stack[pl]
                    break
            if parent is not None:
                edges.append(f"  {parent} --> {nid}")
        header = (
            "flowchart TB\n"
            "  classDef heading fill:#eef2ff,stroke:#6366f1,color:#111827,stroke-width:1px;\n"
        )
        mermaid = header + ("\n".join(nodes + edges) if nodes else "  A[\"README\"] --> B[\"No headings\"]")
        return ReadmeMap(headings=clean_headings, mermaid=mermaid)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"README not found or inaccessible: {e}")


@app.get("/api/repo/{owner}/{name}/readme-structure", response_model=ReadmeNode)
def get_readme_structure(owner: str, name: str):
    """Return a hierarchical tree of README headings with snippets and anchor URLs."""
    try:
        gh = gh_client()
        repo = gh.get_repo(f"{owner}/{name}")
        readme = repo.get_readme()
        content = base64.b64decode(readme.content).decode("utf-8", errors="ignore")

        lines = content.splitlines()
        # Collect reference-style link definitions present anywhere in the README
        import re
        ref_def_lines: list[str] = []
        ref_def_re = re.compile(r"^\s*\[[^\]]+\]:\s*.+$")
        for ln in lines:
            if ref_def_re.match(ln):
                ref_def_lines.append(ln.rstrip())
        # Collect headings with line numbers
        headings_idx: List[tuple[int, int, str]] = []  # (level, line_no, title)
        for idx, line in enumerate(lines):
            if line.startswith('#'):
                level = len(line) - len(line.lstrip('#'))
                title = line.lstrip('#').strip()
                if title:
                    headings_idx.append((level, idx, title))

        if not headings_idx:
            raise HTTPException(status_code=404, detail="No markdown headings found in README")

        # Helper: sanitize title for slug
        def make_slug(t: str) -> str:
            s = t.lower()
            s = re.sub(r"[^a-z0-9\s-]", "", s)
            s = re.sub(r"\s+", "-", s)
            s = re.sub(r"-+", "-", s).strip('-')
            return s or "section"

        # Helper: snippet text + links between this heading and next, skipping code fences and images
        def get_section_summary(start_line: int, end_line: int) -> tuple[Optional[str], List[dict], Optional[dict], Optional[str], List[dict]]:
            in_code = False
            code_started_at = None
            code_lang = None
            code_lines: List[str] = []
            buff: List[str] = []
            links: List[dict] = []
            # Capture raw markdown between headings (including images and code)
            raw_md_lines: List[str] = []
            # Extract badges from heading line: [![alt](img)](href) or ![alt](img)
            heading_line = lines[start_line].rstrip('\n')
            heading_body = heading_line.lstrip('#').strip()
            badge_re = re.compile(r"\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)|!\[([^\]]*)\]\(([^)]+)\)")
            badges: List[dict] = []
            for m in badge_re.finditer(heading_body):
                if m.group(1) is not None:
                    # linked image badge
                    alt, img, href = m.group(1), m.group(2), m.group(3)
                    badges.append({"alt": alt or None, "image": img, "href": href})
                else:
                    alt2, img2 = m.group(4), m.group(5)
                    badges.append({"alt": alt2 or None, "image": img2, "href": None})
            for i in range(start_line + 1, end_line):
                raw_line = lines[i].rstrip('\n')
                raw_md_lines.append(raw_line)
                ln = raw_line.strip()
                if ln.startswith("```"):
                    # toggle fence
                    if not in_code:
                        # opening fence; capture language if present
                        parts = ln.strip('`').strip().split()
                        code_lang = parts[0] if parts else None
                        in_code = True
                        code_started_at = i
                    else:
                        in_code = False
                    continue
                if in_code:
                    # capture only first fenced block under the heading (limit size)
                    if len(code_lines) < 120:
                        code_lines.append(raw_line)
                    continue
                if not ln:
                    continue
                # collect markdown links on this line
                for m in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", ln):
                    text, url = m.group(1), m.group(2)
                    if url.startswith('#'):
                        continue
                    links.append({"text": text, "url": url})
                buff.append(ln)
                if len(" ".join(buff)) > 600:
                    break
            code_obj = None
            if code_lines:
                # trim leading/trailing empty lines
                while code_lines and not code_lines[0].strip():
                    code_lines.pop(0)
                while code_lines and not code_lines[-1].strip():
                    code_lines.pop()
                if code_lines:
                    code_obj = {"lang": code_lang, "content": "\n".join(code_lines[:120])}
            if not buff and not links and not code_obj:
                # Still return markdown if exists
                md_joined = "\n".join(raw_md_lines).strip() or None
                if md_joined and ref_def_lines:
                    md_joined = md_joined + "\n\n" + "\n".join(ref_def_lines)
                return None, [], None, md_joined, badges
            # Keep line breaks to preserve bullet/paragraph structure for the frontend renderer
            snippet = "\n".join(buff).strip()
            if len(snippet) > 600:
                snippet = snippet[:597] + "..."
            # limit links to 8
            uniq = []
            seen = set()
            for l in links:
                k = (l["text"], l["url"])
                if k in seen:
                    continue
                seen.add(k)
                uniq.append(l)
                if len(uniq) >= 8:
                    break
            md_joined = "\n".join(raw_md_lines).strip() or None
            if md_joined and ref_def_lines:
                # Append reference definitions so any [ref] used in section can resolve
                md_joined = md_joined + "\n\n" + "\n".join(ref_def_lines)
            return (snippet or None), uniq, code_obj, md_joined, badges

        base_url = f"https://github.com/{owner}/{name}#"

        # Build nodes with start/end lines
        nodes_tmp: List[dict] = []
        for i, (lvl, ln, title) in enumerate(headings_idx):
            end_line = headings_idx[i + 1][1] if i + 1 < len(headings_idx) else len(lines)
            slug = make_slug(title)
            nodes_tmp.append({
                "level": lvl,
                "title": title,
                "line": ln,
                "end": end_line,
                "slug": slug,
                "url": base_url + slug,
                "_summary": get_section_summary(ln, end_line),
            })

        # Do not limit; return all sections to match the README fully

        # Create hierarchical tree using a stack of last nodes by level
        root = {"id": "ROOT", "level": 0, "title": repo.full_name, "slug": "", "url": f"https://github.com/{owner}/{name}", "snippet": None, "links": [], "children": []}
        last_by_level: dict[int, dict] = {0: root}
        for idx, nd in enumerate(nodes_tmp):
            snippet, links_list, code_obj, markdown, badges = nd["_summary"]
            node = {"id": f"N{idx}", "level": nd["level"], "title": nd["title"], "slug": nd["slug"], "url": nd["url"], "snippet": snippet, "markdown": markdown, "links": links_list, "code": code_obj, "badges": badges, "children": []}
            # find parent with lower level
            parent = None
            for pl in range(node["level"] - 1, -1, -1):
                if pl in last_by_level:
                    parent = last_by_level[pl]
                    break
            (parent or root)["children"].append(node)
            last_by_level[node["level"]] = node

        # Cast to Pydantic model
        def to_model(d: dict) -> ReadmeNode:
            return ReadmeNode(
                id=d["id"],
                level=d["level"],
                title=d["title"],
                slug=d.get("slug", ""),
                url=d.get("url", ""),
                snippet=d.get("snippet"),
                markdown=d.get("markdown"),
                links=[ReadmeLink(**l) for l in d.get("links", [])],
                code=ReadmeCode(**d["code"]) if d.get("code") else None,
                badges=[ReadmeBadge(**b) for b in d.get("badges", [])],
                children=[to_model(c) for c in d.get("children", [])]
            )

        return to_model(root)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"README structure not available: {e}")


class Contributor(BaseModel):
    login: str
    contributions: int
    avatar_url: Optional[str]
    profile_url: Optional[str]


class ContributorsResponse(BaseModel):
    top: List[Contributor]
    weekly_activity: List[int]  # last 12 weeks commit counts


@app.get("/api/repo/{owner}/{name}/contributors", response_model=ContributorsResponse)
def get_contributors(owner: str, name: str):
    try:
        gh = gh_client()
        repo = gh.get_repo(f"{owner}/{name}")
        # Top contributors
        top = []
        for c in repo.get_contributors()[:10]:
            top.append(Contributor(
                login=c.login,
                contributions=getattr(c, 'contributions', 0) or 0,
                avatar_url=getattr(c, 'avatar_url', None),
                profile_url=getattr(c, 'html_url', None),
            ))
        # Weekly commit activity (52 weeks list of dict with total)
        stats = repo.get_stats_commit_activity()
        weeks = []
        if stats is not None:
            # Return the last 26 weeks to provide a wider activity horizon
            weeks = [w.total for w in stats][-26:]
        return ContributorsResponse(top=top, weekly_activity=weeks)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Unable to fetch contributors/activity: {e}")


class HealthScore(BaseModel):
    score: int
    level: str  # green/yellow/red
    reasons: List[str]


def compute_health(repo) -> HealthScore:
    score = 100
    reasons: List[str] = []

    # Recency of last push
    if repo.pushed_at:
        days = (datetime.now(timezone.utc) - repo.pushed_at).days
        if days > 180:
            score -= 40; reasons.append("No recent activity (>180d)")
        elif days > 60:
            score -= 20; reasons.append("Low recent activity (>60d)")
        elif days > 14:
            score -= 10; reasons.append("Slower activity (>14d)")
    else:
        score -= 20; reasons.append("Unknown last push date")

    # Issues pressure vs stars
    try:
        issues = repo.open_issues_count or 0
        stars = repo.stargazers_count or 0
        if stars == 0 and issues > 5:
            score -= 10; reasons.append("Many open issues with few stars")
        elif stars > 0 and issues / max(1, stars) > 0.2:
            score -= 10; reasons.append("High open issues vs stars")
    except Exception:
        pass

    # Recent commits last 4 weeks
    try:
        stats = repo.get_stats_commit_activity()
        recent = sum([w.total for w in stats][-4:]) if stats else 0
        if recent == 0:
            score -= 20; reasons.append("No commits last 4 weeks")
        elif recent < 5:
            score -= 10; reasons.append("Low commits last 4 weeks")
    except Exception:
        pass

    score = max(0, min(100, score))
    level = 'green' if score >= 70 else ('yellow' if score >= 40 else 'red')
    return HealthScore(score=score, level=level, reasons=reasons)


@app.get("/api/repo/{owner}/{name}/health", response_model=HealthScore)
def get_health(owner: str, name: str):
    try:
        gh = gh_client()
        repo = gh.get_repo(f"{owner}/{name}")
        return compute_health(repo)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Unable to compute health: {e}")


@app.get("/api/repo/{owner}/{name}/health-badge.svg")
def health_badge(owner: str, name: str):
    try:
        gh = gh_client()
        repo = gh.get_repo(f"{owner}/{name}")
        health = compute_health(repo)
        color = { 'green': '#10b981', 'yellow': '#f59e0b', 'red': '#ef4444' }[health.level]
        label = "health"
        value = f"{health.score}/100"
        # Simple flat badge SVG
        left_w = 60
        right_w = 70
        total_w = left_w + right_w
        svg = f"""
<svg xmlns='http://www.w3.org/2000/svg' width='{total_w}' height='20' role='img' aria-label='{label}: {value}'>
  <linearGradient id='s' x2='0' y2='100%'>
    <stop offset='0' stop-color='#bbb' stop-opacity='.1'/>
    <stop offset='1' stop-opacity='.1'/>
  </linearGradient>
  <mask id='m'><rect width='{total_w}' height='20' rx='3' fill='#fff'/></mask>
  <g mask='url(#m)'>
    <rect width='{left_w}' height='20' fill='#555'/>
    <rect x='{left_w}' width='{right_w}' height='20' fill='{color}'/>
    <rect width='{total_w}' height='20' fill='url(#s)'/>
  </g>
  <g fill='#fff' text-anchor='middle' font-family='DejaVu Sans,Verdana,Geneva,sans-serif' font-size='11'>
    <text x='{left_w/2}' y='15'>{label}</text>
    <text x='{left_w + right_w/2}' y='15'>{value}</text>
  </g>
</svg>
"""
        from fastapi.responses import Response
        return Response(content=svg, media_type="image/svg+xml")
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Unable to render badge: {e}")


# ----------------------------
# Static Analysis
# ----------------------------

class StaticAnalysisResponse(BaseModel):
    mi_avg: Optional[float] = None
    worst_files: List[Dict[str, object]] = []  # {path, mi, cc_avg}
    flake8: Dict[str, object] = {}             # {total, by_code}
    advice: List[str] = []
    analyzed_commit: Optional[str] = None
    by_severity: Dict[str, int] = {}
    coverage_pct: Optional[float] = None
    grade: Optional[str] = None


def _run(cmd: List[str], cwd: Optional[str] = None, timeout: int = 60) -> tuple[int, str, str]:
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def _quality_grade(mi_avg: Optional[float], lint_total: int) -> str:
    """Return a coarse A–F grade based on maintainability and lint volume."""
    try:
        mi = mi_avg if (mi_avg is not None) else 70.0
        # Base grade from MI
        if mi >= 80:
            base = 'A'
        elif mi >= 70:
            base = 'B'
        elif mi >= 60:
            base = 'C'
        elif mi >= 50:
            base = 'D'
        else:
            base = 'E'
        # Penalize for high lint volume
        if lint_total is None:
            lint_total = 0
        if lint_total > 300:
            return 'F'
        if lint_total > 150 and base < 'E':
            return 'E'
        if lint_total > 80 and base > 'C':
            return 'C'
        if lint_total > 30 and base == 'A':
            return 'B'
        return base
    except Exception:
        return 'C'

@app.get("/api/repo/{owner}/{name}/static-analysis", response_model=StaticAnalysisResponse)
def static_analysis(owner: str, name: str, max_files: int = 2000, clone_timeout: int = 240):
    # Determine latest commit for cache key
    try:
        headers = _gh_headers()
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            repo_resp = client.get(f"https://api.github.com/repos/{owner}/{name}", headers=headers)
            if repo_resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Repository not found.")
            repo_resp.raise_for_status()
            rj = repo_resp.json()
            default_branch = rj.get("default_branch", "main")
            br_resp = client.get(f"https://api.github.com/repos/{owner}/{name}/branches/{default_branch}", headers=headers)
            last_sha = None
            if br_resp.status_code == 200:
                last_sha = (br_resp.json() or {}).get("commit", {}).get("sha")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to resolve default branch: {e}")

    cache_key = f"{owner}/{name}@{last_sha or 'unknown'}"
    cached = _cache_get(_ANALYSIS_CACHE, cache_key)
    if cached:
        return StaticAnalysisResponse(**cached)

    tmpdir = tempfile.mkdtemp(prefix="analyze_")
    try:
        # Shallow clone and ensure we don't fetch huge history
        repo_url = f"https://github.com/{owner}/{name}.git"
        code, out, err = _run(["git", "clone", "--depth", "1", "--no-single-branch", repo_url, tmpdir], timeout=max(60, min(900, clone_timeout)))
        if code != 0:
            raise HTTPException(status_code=502, detail=f"git clone failed: {err or out}")

        # Discover Python, JS/TS, and other languages up to a cap
        py_files: List[str] = []
        js_files: List[str] = []
        go_files: List[str] = []
        java_files: List[str] = []
        cs_files: List[str] = []
        php_files: List[str] = []
        rb_files: List[str] = []
        for root, dirs, files in os.walk(tmpdir):
            bn = os.path.basename(root)
            if bn in {'.git', '.venv', 'venv', 'node_modules', 'dist', 'build', '__pycache__'}:
                continue
            for fn in files:
                if fn.endswith('.py'):
                    py_files.append(os.path.join(root, fn))
                elif any(fn.endswith(ext) for ext in ('.js', '.jsx', '.ts', '.tsx')):
                    js_files.append(os.path.join(root, fn))
                elif fn.endswith('.go'):
                    go_files.append(os.path.join(root, fn))
                elif fn.endswith('.java'):
                    java_files.append(os.path.join(root, fn))
                elif fn.endswith('.cs'):
                    cs_files.append(os.path.join(root, fn))
                elif fn.endswith('.php'):
                    php_files.append(os.path.join(root, fn))
                elif fn.endswith('.rb'):
                    rb_files.append(os.path.join(root, fn))
                # Respect an overall cap to keep things fast
                if (len(py_files) + len(js_files) + len(go_files) + len(java_files) + len(cs_files) + len(php_files) + len(rb_files)) >= max(50, min(5000, max_files)):
                    break
            if (len(py_files) + len(js_files) + len(go_files) + len(java_files) + len(cs_files) + len(php_files) + len(rb_files)) >= max(50, min(5000, max_files)):
                break

        if not py_files and js_files:
            # JS/TS analysis path (ESLint + Plato via npx when available)
            mi_avg: Optional[float] = None
            worst: List[Dict[str, object]] = []
            lint_summary: Dict[str, object] = {"total": 0, "by_code": {}}
            sev_counts: Dict[str, int] = {}
            advice: List[str] = []

            # Limit the number of files passed to tools
            files_for_tools = js_files[:min(1500, len(js_files))]

            def _has_eslint_config(repo_root: str) -> bool:
                try:
                    pkg_json = os.path.join(repo_root, 'package.json')
                    if os.path.exists(pkg_json):
                        with open(pkg_json, 'r', encoding='utf-8', errors='ignore') as f:
                            pj = json.load(f)
                        if isinstance(pj, dict) and pj.get('eslintConfig'):
                            return True
                    for name in ('.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml'):
                        if os.path.exists(os.path.join(repo_root, name)):
                            return True
                except Exception:
                    pass
                return False

            # Try ESLint if config is present
            try:
                if _has_eslint_config(tmpdir):
                    code_es, out_es, err_es = _run(['npx', '--yes', 'eslint', '-f', 'json', '--no-error-on-unmatched-pattern', *files_for_tools], cwd=tmpdir, timeout=120)
                    # Extract JSON array from output (some runners may print warnings)
                    es_json_text = ''
                    if out_es:
                        s = out_es.strip()
                        l = s.find('[')
                        r = s.rfind(']')
                        if l != -1 and r != -1 and r > l:
                            es_json_text = s[l:r+1]
                    if es_json_text:
                        try:
                            arr = json.loads(es_json_text)
                            by_code: Dict[str, int] = {}
                            total = 0
                            if isinstance(arr, list):
                                for file_res in arr:
                                    for msg in (file_res.get('messages') or []):
                                        rule = msg.get('ruleId') or 'unknown'
                                        by_code[rule] = by_code.get(rule, 0) + 1
                                        total += 1
                                        sev = msg.get('severity')
                                        # 1=warning, 2=error per ESLint
                                        if sev == 2:
                                            sev_counts['error'] = sev_counts.get('error', 0) + 1
                                        else:
                                            sev_counts['warning'] = sev_counts.get('warning', 0) + 1
                            lint_summary = {"total": total, "by_code": by_code}
                            if total > 0:
                                advice.append("ESLint issues detected; address the most frequent rules first.")
                        except Exception:
                            pass
                else:
                    advice.append("No ESLint config found; skipping JS lint analysis. See https://eslint.org/docs/latest/use/getting-started and https://typescript-eslint.io if using TypeScript.")
            except Exception as e:
                advice.append(f"ESLint not available (npx failed): {e}. Install Node.js and ESLint. Docs: https://eslint.org/docs/latest/use/getting-started")

            # Try Plato for complexity/maintainability if available
            try:
                outdir = os.path.join(tmpdir, 'plato_report')
                os.makedirs(outdir, exist_ok=True)
                # plato CLI: npx plato -r -d out file1 file2 ...
                code_pl, out_pl, err_pl = _run(['npx', '--yes', 'plato', '-r', '-d', outdir, *files_for_tools[:200]], cwd=tmpdir, timeout=180)
                report_path = os.path.join(outdir, 'report.json')
                if os.path.exists(report_path):
                    with open(report_path, 'r', encoding='utf-8', errors='ignore') as f:
                        rep = json.load(f)
                    # rep is an array of file reports
                    cc_vals: List[float] = []
                    mi_vals: List[float] = []
                    for fr in (rep if isinstance(rep, list) else []):
                        try:
                            # cyclomatic complexity average
                            cc = (((fr.get('complexity') or {}).get('aggregate') or {}).get('cyclomatic') or None)
                            if isinstance(cc, (int, float)):
                                cc_vals.append(float(cc))
                            # maintainability is often 0..100 per file
                            m = (fr.get('maintainability') if 'maintainability' in fr else ((fr.get('complexity') or {}).get('aggregate') or {}).get('maintainability'))
                            if isinstance(m, (int, float)):
                                mi_vals.append(float(m))
                        except Exception:
                            continue
                    if mi_vals:
                        mi_avg = sum(mi_vals) / len(mi_vals)
                    # worst files by highest complexity
                    worst_pairs = []
                    for fr in (rep if isinstance(rep, list) else []):
                        try:
                            cc = (((fr.get('complexity') or {}).get('aggregate') or {}).get('cyclomatic') or 0.0)
                            path = fr.get('info', {}).get('file', {}).get('path') or fr.get('path') or 'unknown'
                            worst_pairs.append((path, float(cc)))
                        except Exception:
                            continue
                    worst_pairs.sort(key=lambda t: -t[1])
                    worst = [{"path": p, "mi": None, "cc_avg": c} for p, c in worst_pairs[:10]]
                else:
                    advice.append("Plato report not generated; complexity analysis skipped.")
            except Exception as e:
                advice.append(f"Plato not available (npx failed): {e}")

            resp = StaticAnalysisResponse(
                mi_avg=mi_avg,
                worst_files=worst,
                flake8=lint_summary,  # reuse schema for ESLint counts
                advice=advice if advice else ["JS/TS analysis completed."],
                by_severity=sev_counts,
                coverage_pct=None,
                grade=_quality_grade(mi_avg, int((lint_summary or {}).get("total", 0) or 0)),
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        if not py_files and not js_files and go_files:
            # Go analysis via golangci-lint when available
            lint_summary: Dict[str, object] = {"total": 0, "by_code": {}}
            advice: List[str] = []
            try:
                # Run in repo root; golangci-lint discovers packages automatically
                code_gl, out_gl, err_gl = _run(["golangci-lint", "run", "--out-format", "json"], cwd=tmpdir, timeout=180)
                if out_gl.strip():
                    try:
                        data = json.loads(out_gl)
                        by_code: Dict[str, int] = {}
                        total = 0
                        for iss in (data.get("Issues") or data.get("issues") or []):
                            rule = iss.get("FromLinter") or iss.get("fromLinter") or iss.get("severity") or "issue"
                            by_code[rule] = by_code.get(rule, 0) + 1
                            total += 1
                            sev = (iss.get('Severity') or iss.get('severity') or '').lower()
                            if sev in ('error','warning','info'):
                                sev_counts[sev] = sev_counts.get(sev, 0) + 1
                        lint_summary = {"total": total, "by_code": by_code}
                        if total > 0:
                            advice.append("golangci-lint issues detected; address common linters first.")
                    except Exception:
                        pass
                else:
                    advice.append("golangci-lint produced no output; ensure modules build. Docs: https://golangci-lint.run/usage/install/ and https://golangci-lint.run/usage/configuration/")
            except Exception as e:
                advice.append(f"golangci-lint not available: {e}. Install from https://golangci-lint.run/usage/install/")

            resp = StaticAnalysisResponse(
                mi_avg=None,
                worst_files=[],
                flake8=lint_summary,
                advice=advice if advice else ["Go analysis completed."],
                by_severity=sev_counts,
                coverage_pct=None,
                grade=_quality_grade(None, int((lint_summary or {}).get("total", 0) or 0)),
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        # PHP analysis via phpcs if available (when no Py/JS/Go path was taken)
        if not py_files and not js_files and not go_files and php_files:
            lint_summary: Dict[str, object] = {"total": 0, "by_code": {}}
            advice: List[str] = []
            try:
                # phpcs --report=json over a limited set of files
                files_for_tools = php_files[:200]
                code_p, out_p, err_p = _run(["phpcs", "--report=json", *files_for_tools], cwd=tmpdir, timeout=150)
                if out_p.strip():
                    try:
                        data = json.loads(out_p)
                        by_code: Dict[str, int] = {}
                        total = 0
                        files_section = (data.get("files") or {})
                        for fpath, fobj in files_section.items():
                            for msg in (fobj.get("messages") or []):
                                code_id = str(msg.get("source") or msg.get("type") or "issue")
                                by_code[code_id] = by_code.get(code_id, 0) + 1
                                total += 1
                                t = (msg.get('type') or '').lower()
                                if t in ('error','warning'):
                                    sev_counts[t] = sev_counts.get(t, 0) + 1
                        lint_summary = {"total": total, "by_code": by_code}
                        if total > 0:
                            advice.append("PHP CodeSniffer issues detected; address the most frequent rules first.")
                    except Exception:
                        advice.append("Unable to parse phpcs JSON output.")
                else:
                    advice.append("phpcs produced no output; ensure it is configured. Docs: https://github.com/squizlabs/PHP_CodeSniffer")
            except Exception as e:
                advice.append(f"phpcs not available: {e}. Install with Composer or PHAR. Docs: https://github.com/squizlabs/PHP_CodeSniffer#installation")

            resp = StaticAnalysisResponse(
                mi_avg=None,
                worst_files=[],
                flake8=lint_summary,
                advice=advice if advice else ["PHP analysis completed."],
                by_severity=sev_counts,
                coverage_pct=None,
                grade=_quality_grade(None, int((lint_summary or {}).get("total", 0) or 0)),
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        # Ruby analysis via rubocop if available (when no Py/JS/Go/PHP path was taken)
        if not py_files and not js_files and not go_files and not php_files and rb_files:
            lint_summary: Dict[str, object] = {"total": 0, "by_code": {}}
            advice: List[str] = []
            try:
                files_for_tools = rb_files[:200]
                code_r, out_r, err_r = _run(["rubocop", "--format", "json", *files_for_tools], cwd=tmpdir, timeout=150)
                if out_r.strip():
                    try:
                        data = json.loads(out_r)
                        offenses = 0
                        by_code: Dict[str, int] = {}
                        for f in (data.get("files") or []):
                            for off in (f.get("offenses") or []):
                                cop = off.get("cop_name") or "offense"
                                by_code[cop] = by_code.get(cop, 0) + 1
                                offenses += 1
                                sev = (off.get('severity') or '').lower()
                                if sev in ('error','warning','convention','refactor','info'):
                                    key = 'warning' if sev in ('convention','refactor') else (sev if sev in ('error','warning','info') else 'warning')
                                    sev_counts[key] = sev_counts.get(key, 0) + 1
                        lint_summary = {"total": offenses, "by_code": by_code}
                        if offenses > 0:
                            advice.append("RuboCop offenses detected; prioritize the most frequent cops.")
                    except Exception:
                        advice.append("Unable to parse rubocop JSON output.")
                else:
                    advice.append("rubocop produced no output; ensure it is configured. Docs: https://docs.rubocop.org/rubocop/installation.html")
            except Exception as e:
                advice.append(f"rubocop not available: {e}. Install via gem or bundler. Docs: https://docs.rubocop.org/rubocop/installation.html")

            resp = StaticAnalysisResponse(
                mi_avg=None,
                worst_files=[],
                flake8=lint_summary,
                advice=advice if advice else ["Ruby analysis completed."],
                by_severity=sev_counts,
                coverage_pct=None,
                grade=_quality_grade(None, int((lint_summary or {}).get("total", 0) or 0)),
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        # Java analysis via SpotBugs (Maven) or Checkstyle if available (when no Py/JS/Go/PHP/Ruby path was taken)
        if not py_files and not js_files and not go_files and not php_files and not rb_files and java_files:
            lint_summary: Dict[str, object] = {"total": 0, "by_code": {}}
            advice: List[str] = []
            try:
                # Prefer SpotBugs through Maven if available to catch bugs (requires mvn and plugin)
                mvn_ok = False
                try:
                    c_mv, o_mv, e_mv = _run(["mvn", "-q", "-v"], cwd=tmpdir, timeout=15)
                    mvn_ok = (c_mv == 0)
                except Exception:
                    mvn_ok = False
                if mvn_ok:
                    # Attempt to generate SpotBugs report
                    _run(["mvn", "-q", "-DskipTests", "compile"], cwd=tmpdir, timeout=240)
                    code_sb, out_sb, err_sb = _run(["mvn", "-q", "-DskipTests", "spotbugs:spotbugs"], cwd=tmpdir, timeout=240)
                    # Common output path
                    sb_paths = [
                        os.path.join(tmpdir, "target", "spotbugsXml.xml"),
                        os.path.join(tmpdir, "spotbugsXml.xml"),
                    ]
                    sb_xml = None
                    for pth in sb_paths:
                        if os.path.exists(pth):
                            try:
                                with open(pth, 'r', encoding='utf-8', errors='ignore') as f:
                                    sb_xml = f.read()
                                break
                            except Exception:
                                pass
                    if sb_xml:
                        try:
                            # Count BugInstance types
                            by_code: Dict[str, int] = {}
                            total = 0
                            for m in re.finditer(r"<BugInstance[^>]*type=\"([^\"]+)\"", sb_xml):
                                t = m.group(1)
                                by_code[t] = by_code.get(t, 0) + 1
                                total += 1
                            lint_summary = {"total": total, "by_code": by_code}
                            if total > 0:
                                advice.append("SpotBugs issues detected; prioritize common bug patterns.")
                        except Exception:
                            advice.append("Unable to parse SpotBugs XML output.")
                # Fallback to Checkstyle if SpotBugs not available or produced nothing
                if lint_summary.get("total", 0) == 0:
                    # Try checkstyle on the repo directory; requires checkstyle on PATH
                    code_cs, out_cs, err_cs = _run(["checkstyle", "-f", "xml", "-r", "."], cwd=tmpdir, timeout=180)
                    xml_text = out_cs or err_cs or ""
                    if xml_text.strip():
                        try:
                            # Lightweight XML parse via regex to count <error source="rule">
                            by_code: Dict[str, int] = {}
                            total = 0
                            for m in re.finditer(r"<error[^>]*source=\"([^\"]+)\"[^>]*severity=\"([^\"]+)\"", xml_text):
                                rule = m.group(1).split('.')[-1]
                                by_code[rule] = by_code.get(rule, 0) + 1
                                total += 1
                                sev = (m.group(2) or '').lower()
                                if sev:
                                    sev_counts[sev] = sev_counts.get(sev, 0) + 1
                            lint_summary = {"total": total, "by_code": by_code}
                            if total > 0:
                                advice.append("Checkstyle issues detected; address the most common rules.")
                            else:
                                advice.append("Checkstyle produced no issues.")
                        except Exception:
                            advice.append("Unable to parse Checkstyle XML output.")
                    else:
                        advice.append("Checkstyle produced no output; ensure it is installed and configured.")
            except Exception as e:
                advice.append(f"Checkstyle not available: {e}")

            resp = StaticAnalysisResponse(
                mi_avg=None,
                worst_files=[],
                flake8=lint_summary,
                advice=advice if advice else ["Java analysis completed."],
                by_severity=sev_counts,
                coverage_pct=None,
                grade=_quality_grade(None, int((lint_summary or {}).get("total", 0) or 0)),
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        # C# analysis via dotnet format analyzers or build warnings (when no other analyzers were used)
        if not py_files and not js_files and not go_files and not php_files and not rb_files and not java_files and cs_files:
            lint_summary: Dict[str, object] = {"total": 0, "by_code": {}}
            advice: List[str] = []
            try:
                # Prefer dotnet format analyzers with SARIF output
                sarif_path = os.path.join(tmpdir, "analyzers.sarif")
                code_df, out_df, err_df = _run(["dotnet", "format", "analyzers", "--verify-no-changes", "--severity", "info", "--report", sarif_path, "--report-format", "sarif"], cwd=tmpdir, timeout=300)
                if os.path.exists(sarif_path):
                    try:
                        with open(sarif_path, 'r', encoding='utf-8', errors='ignore') as f:
                            sar = json.load(f)
                        by_code: Dict[str, int] = {}
                        total = 0
                        for run in (sar.get('runs') or []):
                            for res in (run.get('results') or []):
                                rid = res.get('ruleId') or 'analyzer'
                                by_code[rid] = by_code.get(rid, 0) + 1
                                total += 1
                                lvl = (res.get('level') or '').lower()
                                if lvl in ('error','warning','note'):
                                    sev_key = 'info' if lvl == 'note' else lvl
                                    sev_counts[sev_key] = sev_counts.get(sev_key, 0) + 1
                        lint_summary = {"total": total, "by_code": by_code}
                        if total > 0:
                            advice.append("dotnet analyzers reported diagnostics; fix the most frequent rule IDs.")
                    except Exception:
                        advice.append("Unable to parse dotnet analyzers SARIF output.")
                if lint_summary.get("total", 0) == 0:
                    # Fallback to capturing build warnings
                    code_db, out_db, err_db = _run(["dotnet", "build", "-nologo", "-clp:ErrorsOnly"], cwd=tmpdir, timeout=240)
                    txt = (out_db or "") + "\n" + (err_db or "")
                    by_code: Dict[str, int] = {}
                    total = 0
                    for m in re.finditer(r"warning\s+([A-Z]{2,}\d{2,})", txt):
                        code = m.group(1)
                        by_code[code] = by_code.get(code, 0) + 1
                        total += 1
                    if total > 0:
                        sev_counts['warning'] = total
                    lint_summary = {"total": total, "by_code": by_code}
                    if total > 0:
                        advice.append("C# build warnings detected; fix the most frequent analyzer codes.")
                    else:
                        advice.append("No warnings captured from dotnet build.")
            except Exception as e:
                advice.append(f"dotnet analyzers unavailable: {e}. Ensure .NET SDK is installed. Docs: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/overview")

            resp = StaticAnalysisResponse(
                mi_avg=None,
                worst_files=[],
                flake8=lint_summary,
                advice=advice if advice else ["C# analysis completed."],
                by_severity=sev_counts,
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        if not py_files and not js_files and not go_files and (java_files or cs_files):
            # Placeholders for other languages with guidance
            tips: List[str] = []
            if java_files:
                tips.append("Java detected: integrate Checkstyle/SpotBugs for deeper analysis.")
            if cs_files:
                tips.append("C# detected: integrate Roslyn analyzers or dotnet format --verify-no-changes.")
            resp = StaticAnalysisResponse(
                mi_avg=None,
                worst_files=[],
                flake8={"total": 0, "by_code": {}},
                advice=tips or ["No supported analyzer available for detected languages."],
                coverage_pct=None,
                grade=_quality_grade(None, 0),
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        if not py_files and not js_files and not go_files:
            resp = StaticAnalysisResponse(
                mi_avg=None,
                worst_files=[],
                flake8={"total": 0, "by_code": {}},
                advice=["No supported source files detected; static analysis skipped."],
                coverage_pct=None,
                grade=_quality_grade(None, 0),
            )
            _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
            return resp

        # Run radon CC and MI (JSON) against limited file set
        mi_avg: Optional[float] = None
        worst: List[Dict[str, object]] = []

        # Limit number of files passed to avoid command line too long on Windows
        files_for_tools = py_files[:min(1500, len(py_files))]
        code_cc, out_cc, err_cc = _run([sys.executable, "-m", "radon", "cc", "-s", "-j", *files_for_tools], cwd=None, timeout=90)
        if code_cc == 0 and out_cc.strip():
            try:
                cc_data = json.loads(out_cc)
                # Compute simple average CC per file to help ranking
                cc_scores: Dict[str, float] = {}
                for path, items in cc_data.items():
                    if not isinstance(items, list) or not items:
                        continue
                    avg = sum([it.get("complexity", 0) for it in items if isinstance(it, dict)]) / max(1, len(items))
                    cc_scores[path] = avg
            except Exception:
                cc_scores = {}
        else:
            cc_scores = {}

        code_mi, out_mi, err_mi = _run([sys.executable, "-m", "radon", "mi", "-j", *files_for_tools], cwd=None, timeout=90)
        mi_values: List[float] = []
        if code_mi == 0 and out_mi.strip():
            try:
                mi_data = json.loads(out_mi)
                for path, val in mi_data.items():
                    try:
                        v = float(val)
                        mi_values.append(v)
                    except Exception:
                        pass
                if mi_values:
                    mi_avg = sum(mi_values) / len(mi_values)
            except Exception:
                pass

        # Select worst files by low MI / high CC
        worst_candidates: List[tuple[str, float, float]] = []  # (path, mi, cc_avg)
        try:
            for path in set(list(cc_scores.keys()) + list((json.loads(out_mi).keys() if (code_mi == 0 and out_mi.strip()) else []))):
                mi_val = None
                try:
                    if code_mi == 0 and out_mi.strip():
                        mi_val = float(json.loads(out_mi).get(path))
                except Exception:
                    mi_val = None
                cc_val = cc_scores.get(path, 0.0)
                worst_candidates.append((path, (mi_val if mi_val is not None else 101.0), cc_val))
        except Exception:
            pass

        # Rank worst candidates: prioritize low MI then high CC
        worst_candidates.sort(key=lambda t: (t[1], -t[2]))
        worst = [
            {"path": p, "mi": (mi if mi is not None else None), "cc_avg": cc}
            for p, mi, cc in worst_candidates[:10]
        ]

        # Try to detect coverage.xml and parse line-rate
        coverage_pct: Optional[float] = None
        try:
            cov_path = None
            for root_dir, _dirs, files in os.walk(tmpdir):
                for fn in files:
                    if fn.lower() == 'coverage.xml':
                        cov_path = os.path.join(root_dir, fn)
                        break
                if cov_path:
                    break
            if cov_path and os.path.exists(cov_path):
                try:
                    with open(cov_path, 'r', encoding='utf-8', errors='ignore') as f:
                        cov_txt = f.read()
                    # Look for line-rate=\"0.85\" on <coverage ...>
                    m = re.search(r"line-rate=\\\"([0-9]*\\.?[0-9]+)\\\"", cov_txt)
                    if m:
                        rate = float(m.group(1))
                        coverage_pct = round(rate * 100.0, 1)
                except Exception:
                    coverage_pct = None
        except Exception:
            coverage_pct = None

        # Run flake8 and summarize results
        flake_summary: Dict[str, object] = {"total": 0, "by_code": {}}
        by_severity: Dict[str, int] = {}
        try:
            code_flake, out_flake, err_flake = _run([sys.executable, "-m", "flake8", "."], cwd=tmpdir, timeout=60)
            by_code: Dict[str, int] = {}
            total = 0
            for line in (out_flake or "").splitlines():
                ln = line.strip()
                if not ln:
                    continue
                # Format: path:line:col: CODE message
                try:
                    parts = ln.split(":", 3)
                    if len(parts) < 4:
                        continue
                    rest = parts[3].strip()
                    code_token = rest.split()[0] if rest else None
                    if code_token:
                        by_code[code_token] = by_code.get(code_token, 0) + 1
                        total += 1
                        # map code prefixes to severities (rough heuristic)
                        sev = 'warning'
                        if code_token.startswith(('E','F','W')):
                            sev = 'error' if code_token[0] in ('E','F') else 'warning'
                        elif code_token.startswith(('C','N')):
                            sev = 'info'
                        by_severity[sev] = by_severity.get(sev, 0) + 1
                except Exception:
                    continue
            flake_summary = {"total": total, "by_code": by_code}
        except Exception:
            # flake8 may not run on all repos; keep summary empty
            flake_summary = {"total": 0, "by_code": {}}
            by_severity = {}

        # Simple advice based on metrics
        advice: List[str] = []
        if mi_avg is not None and mi_avg < 60:
            advice.append("Low average Maintainability Index; consider refactoring complex modules.")
        if flake_summary.get("total", 0) > 0:
            advice.append("Lint issues detected; run flake8 locally and address the most frequent codes first.")

        resp = StaticAnalysisResponse(
            mi_avg=mi_avg,
            worst_files=worst,
            flake8=flake_summary,
            advice=advice,
            by_severity=by_severity,
            coverage_pct=coverage_pct,
            grade=_quality_grade(mi_avg, int((flake_summary or {}).get("total", 0) or 0)),
        )
        _cache_set(_ANALYSIS_CACHE, cache_key, resp.model_dump())
        return resp
    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Static analysis timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Static analysis failed: {e}")
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


# ----------------------------
# Architecture Graph (Python)
# ----------------------------

class ArchGraphResponse(BaseModel):
    nodes: List[Dict[str, object]]  # {id, label, type}
    edges: List[Dict[str, object]]  # {source, target, weight}
    stats: Dict[str, object]


def _py_module_name(root: str, filepath: str) -> Optional[str]:
    if not filepath.endswith('.py'):
        return None
    # remove root prefix
    if filepath.startswith(root):
        rel = filepath[len(root):].lstrip(os.sep)
    else:
        rel = filepath
    if rel.endswith('__init__.py'):
        rel = rel[:-12]
    else:
        rel = rel[:-3]
    rel = rel.strip(os.sep)
    if not rel:
        return None
    return rel.replace(os.sep, '.')


def _js_module_id(root: str, filepath: str) -> Optional[str]:
    if not any(filepath.endswith(ext) for ext in ('.js', '.jsx', '.ts', '.tsx')):
        return None
    if filepath.startswith(root):
        rel = filepath[len(root):].lstrip(os.sep)
    else:
        rel = filepath
    for ext in ('.ts', '.tsx', '.js', '.jsx'):
        if rel.endswith(ext):
            rel = rel[:-len(ext)]
            break
    rel = rel.strip(os.sep)
    if not rel:
        return None
    return rel.replace(os.sep, '/')


def _rel_id_without_ext(root: str, filepath: str, exts: List[str], sep: str = '/') -> Optional[str]:
    """Return repo-relative id without extension for files matching given exts."""
    if not any(filepath.endswith(e) for e in exts):
        return None
    if filepath.startswith(root):
        rel = filepath[len(root):].lstrip(os.sep)
    else:
        rel = filepath
    for e in exts:
        if rel.endswith(e):
            rel = rel[:-len(e)]
            break
    rel = rel.strip(os.sep)
    if not rel:
        return None
    return rel.replace(os.sep, sep)


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except Exception:
        return None


def _detect_go_module(root: str) -> Optional[str]:
    mod = _read_text(os.path.join(root, 'go.mod'))
    if not mod:
        return None
    m = re.search(r'^\s*module\s+([^\s]+)', mod, re.M)
    return m.group(1).strip() if m else None

def _find_nearest_package_json(start_dir: str, repo_root: str) -> Optional[dict]:
    """Walk up from start_dir to repo_root to find nearest package.json and return parsed JSON."""
    try:
        cur = start_dir
        # Prevent infinite loop
        while True:
            pj = os.path.join(cur, 'package.json')
            if os.path.exists(pj):
                txt = _read_text(pj)
                if txt:
                    try:
                        return json.loads(txt)
                    except Exception:
                        return None
            if os.path.normpath(cur) == os.path.normpath(repo_root):
                break
            parent = os.path.dirname(cur)
            if not parent or os.path.normpath(parent) == os.path.normpath(cur):
                break
            cur = parent
        return None
    except Exception:
        return None

def _resolve_js_import(module_spec: str, file_dir: str, root: str) -> str:
    # Return a graph node id for the import: either an internal path id or a package name
    spec = module_spec.strip()
    if not spec:
        return spec
    # Relative or absolute within repo
    if spec.startswith('.') or spec.startswith('/'):
        if spec.startswith('/'):
            target = os.path.join(root, spec.lstrip('/'))
        else:
            target = os.path.normpath(os.path.join(file_dir, spec))
        candidates = [
            target,
            target + '.ts', target + '.tsx', target + '.js', target + '.jsx',
            os.path.join(target, 'index.ts'), os.path.join(target, 'index.tsx'),
            os.path.join(target, 'index.js'), os.path.join(target, 'index.jsx'),
        ]
        for c in candidates:
            try:
                if os.path.exists(c):
                    mid = _js_module_id(root, c)
                    if mid:
                        return mid
            except Exception:
                pass
        # Fallback id even if file not found
        try:
            rel = os.path.relpath(target, root)
        except Exception:
            rel = target
        return rel.replace(os.sep, '/')
    # Package import (scoped or unscoped)
    if spec.startswith('@'):
        parts = spec.split('/')
        return '/'.join(parts[:2]) if len(parts) >= 2 else spec
    return spec.split('/', 1)[0]

@app.get("/api/repo/{owner}/{name}/arch-graph", response_model=ArchGraphResponse)
def arch_graph(owner: str, name: str, max_files: int = 3000, lang: str = "all", min_weight: int = 2, node_cap: int = 200):
    # Cache key by latest commit
    try:
        headers = _gh_headers()
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            repo_resp = client.get(f"https://api.github.com/repos/{owner}/{name}", headers=headers)
            if repo_resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Repository not found.")
            repo_resp.raise_for_status()
            rj = repo_resp.json()
            default_branch = rj.get("default_branch", "main")
            br_resp = client.get(f"https://api.github.com/repos/{owner}/{name}/branches/{default_branch}", headers=headers)
            last_sha = None
            if br_resp.status_code == 200:
                last_sha = (br_resp.json() or {}).get("commit", {}).get("sha")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to resolve default branch: {e}")

    cache_key = f"{owner}/{name}@{last_sha or 'unknown'}:{max_files}"
    cached = _cache_get(_ARCH_CACHE, cache_key)
    if cached:
        return ArchGraphResponse(**cached)

    tmpdir = tempfile.mkdtemp(prefix="arch_")
    try:
        repo_url = f"https://github.com/{owner}/{name}.git"
        code, out, err = _run(["git", "clone", "--depth", "1", "--no-single-branch", repo_url, tmpdir], timeout=120)
        if code != 0:
            raise HTTPException(status_code=502, detail=f"git clone failed: {err or out}")

        # Walk files (capped): Python, JS/TS, Go, Java, C#, PHP, Ruby
        py_files: List[str] = []
        js_files: List[str] = []
        go_files: List[str] = []
        java_files: List[str] = []
        cs_files: List[str] = []
        php_files: List[str] = []
        rb_files: List[str] = []
        per_dir_cap = 20  # sample up to N files per directory to keep monorepos fast
        per_dir_counts: Dict[tuple[str, str], int] = {}
        for root, dirs, files in os.walk(tmpdir):
            # Skip venvs, .git, node_modules, dist, build
            bn = os.path.basename(root)
            if bn in {'.git', '.venv', 'venv', 'node_modules', 'dist', 'build', '__pycache__'}:
                continue
            for fn in files:
                key = (root, 'any')
                cnt = per_dir_counts.get(key, 0)
                if cnt >= per_dir_cap:
                    continue
                if fn.endswith('.py'):
                    py_files.append(os.path.join(root, fn))
                elif any(fn.endswith(ext) for ext in ('.js', '.jsx', '.ts', '.tsx')):
                    js_files.append(os.path.join(root, fn))
                elif fn.endswith('.go'):
                    go_files.append(os.path.join(root, fn))
                elif fn.endswith('.java'):
                    java_files.append(os.path.join(root, fn))
                elif fn.endswith('.cs'):
                    cs_files.append(os.path.join(root, fn))
                elif fn.endswith('.php'):
                    php_files.append(os.path.join(root, fn))
                elif fn.endswith('.rb'):
                    rb_files.append(os.path.join(root, fn))
                # update per-dir count only if we accepted a file
                if any(fn.endswith(ext) for ext in ('.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.java', '.cs', '.php', '.rb')):
                    per_dir_counts[key] = per_dir_counts.get(key, 0) + 1
                if (len(py_files) + len(js_files) + len(go_files) + len(java_files) + len(cs_files) + len(php_files) + len(rb_files)) >= max(100, min(10000, max_files)):
                    break
            if (len(py_files) + len(js_files) + len(go_files) + len(java_files) + len(cs_files) + len(php_files) + len(rb_files)) >= max(100, min(10000, max_files)):
                break

        # Determine which languages to include based on 'lang' parameter
        lang_norm = (lang or "all").strip().lower()
        include_py = lang_norm in ("all", "python", "py")
        include_js = lang_norm in ("all", "js", "javascript", "npm")
        include_go = lang_norm in ("all", "go", "golang")
        include_java = lang_norm in ("all", "java")
        include_cs = lang_norm in ("all", "csharp", "cs", ".net", "dotnet")
        include_php = lang_norm in ("all", "php")
        include_rb = lang_norm in ("all", "ruby", "rb")

        # If a specific language is chosen, clear other file lists to reduce work
        if not include_py: py_files = []
        if not include_js: js_files = []
        if not include_go: go_files = []
        if not include_java: java_files = []
        if not include_cs: cs_files = []
        if not include_php: php_files = []
        if not include_rb: rb_files = []

        # Parse imports (only for included languages)
        import_re = re.compile(r"^\s*import\s+([\w\.\,\s]+)|^\s*from\s+([\w\.]+)\s+import\s+", re.M)
        js_import_es = re.compile(r"^\s*import\s+(?:[^'\"\n]+\s+from\s+)?['\"]([^'\"]+)['\"]", re.M)
        js_require = re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)")
        go_import_single = re.compile(r"^\s*import\s+\"([^\"]+)\"", re.M)
        go_import_block = re.compile(r"^\s*import\s*\((.*?)\)", re.S | re.M)
        java_package = re.compile(r"^\s*package\s+([\w\.]+)\s*;", re.M)
        java_import = re.compile(r"^\s*import\s+([\w\.]+)\s*;", re.M)
        cs_namespace = re.compile(r"^\s*namespace\s+([\w\.]+)")
        cs_using = re.compile(r"^\s*using\s+([\w\.]+)\s*;", re.M)
        php_require = re.compile(r"(require|require_once|include|include_once)\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
        ruby_require = re.compile(r"^\s*require\s+['\"]([^'\"]+)['\"]", re.M)
        ruby_require_rel = re.compile(r"^\s*require_relative\s+['\"]([^'\"]+)['\"]", re.M)
        nodes_set: set[str] = set()
        edges_map: Dict[tuple[str, str], int] = {}
        internal_nodes: set[str] = set()
        node_meta: Dict[str, dict] = {}

        # Determine top-level package prefixes from file tree
        for f in (py_files if include_py else []):
            mod = _py_module_name(tmpdir, f)
            if not mod:
                continue
            nodes_set.add(mod)
            internal_nodes.add(mod)
            node_meta.setdefault(mod, {}).setdefault("lang", "python")

        for f in (py_files if include_py else []):
            mod = _py_module_name(tmpdir, f)
            if not mod:
                continue
            try:
                with open(f, 'r', encoding='utf-8', errors='ignore') as fh:
                    src = fh.read()
            except Exception:
                continue
            for m in import_re.finditer(src):
                if m.group(1):
                    # import a, b.c as x
                    raw = m.group(1)
                    for part in re.split(r"\s*,\s*", raw):
                        name = re.split(r"\s+as\s+", part.strip())[0]
                        if not name:
                            continue
                        tgt = name
                        # Keep only first 3 segments for compactness
                        tgt = ".".join(tgt.split(".")[:3])
                        edges_map[(mod, tgt)] = edges_map.get((mod, tgt), 0) + 1
                        nodes_set.add(tgt)
                        node_meta.setdefault(tgt, {}).setdefault("lang", "python")
                elif m.group(2):
                    # from x.y import z
                    base = m.group(2)
                    tgt = ".".join(base.split(".")[:3])
                    edges_map[(mod, tgt)] = edges_map.get((mod, tgt), 0) + 1
                    nodes_set.add(tgt)
                    node_meta.setdefault(tgt, {}).setdefault("lang", "python")

        # Parse JS/TS imports
        js_pkg_json_cache: Dict[str, Optional[dict]] = {}
        def nearest_pkg_json(d: str) -> Optional[dict]:
            if d in js_pkg_json_cache:
                return js_pkg_json_cache[d]
            pj = _find_nearest_package_json(d, tmpdir)
            js_pkg_json_cache[d] = pj
            return pj

        for f in (js_files if include_js else []):
            src_id = _js_module_id(tmpdir, f)
            if not src_id:
                continue
            nodes_set.add(src_id)
            internal_nodes.add(src_id)
            node_meta.setdefault(src_id, {}).setdefault("lang", "js")
            src = _read_text(f)
            if src is None:
                continue
            file_dir = os.path.dirname(f)
            pj = nearest_pkg_json(file_dir)
            deps = {}
            if isinstance(pj, dict):
                for k in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
                    try:
                        dct = pj.get(k) or {}
                        if isinstance(dct, dict):
                            deps.update(dct)
                    except Exception:
                        pass
            for m in js_import_es.finditer(src):
                spec = m.group(1)
                if not spec:
                    continue
                dst = _resolve_js_import(spec, file_dir, tmpdir)
                edges_map[(src_id, dst)] = edges_map.get((src_id, dst), 0) + 1
                nodes_set.add(dst)
                node_meta.setdefault(dst, {}).setdefault("lang", "js")
                if spec.startswith('.') or spec.startswith('/'):
                    internal_nodes.add(dst)
                    node_meta.setdefault(dst, {}).setdefault("lang", "js")
                else:
                    # external package: attach version if known
                    pkg = dst.split('/', 2)[0] if dst.startswith('@') else dst.split('/', 1)[0]
                    ver = deps.get(pkg)
                    if ver and dst not in node_meta:
                        node_meta[dst] = {"pkg": {"manager": "npm", "name": pkg, "version": ver}, "lang": "npm"}
                    else:
                        node_meta.setdefault(dst, {}).setdefault("lang", "npm")
            for m in js_require.finditer(src):
                spec = m.group(1)
                if not spec:
                    continue
                dst = _resolve_js_import(spec, file_dir, tmpdir)
                edges_map[(src_id, dst)] = edges_map.get((src_id, dst), 0) + 1
                nodes_set.add(dst)
                if spec.startswith('.') or spec.startswith('/'):
                    internal_nodes.add(dst)
                    node_meta.setdefault(dst, {}).setdefault("lang", "js")
                else:
                    pkg = dst.split('/', 2)[0] if dst.startswith('@') else dst.split('/', 1)[0]
                    ver = deps.get(pkg)
                    if ver and dst not in node_meta:
                        node_meta[dst] = {"pkg": {"manager": "npm", "name": pkg, "version": ver}, "lang": "npm"}
                    else:
                        node_meta.setdefault(dst, {}).setdefault("lang", "npm")

        # Parse Go imports
        go_module = _detect_go_module(tmpdir) if include_go else None
        for f in (go_files if include_go else []):
            src_id = _rel_id_without_ext(tmpdir, f, ['.go'], '/')
            if not src_id:
                continue
            nodes_set.add(src_id)
            internal_nodes.add(src_id)
            src = _read_text(f)
            if src is None:
                continue
            # single import
            for m in go_import_single.finditer(src):
                spec = m.group(1)
                if not spec:
                    continue
                dst = spec
                if go_module and spec.startswith(go_module):
                    dst = spec[len(go_module):].lstrip('/')
                    internal_nodes.add(dst)
                edges_map[(src_id, dst)] = edges_map.get((src_id, dst), 0) + 1
                nodes_set.add(dst)
            # import block
            for bm in go_import_block.finditer(src):
                block = bm.group(1) or ''
                for m in re.finditer(r'\"([^\"]+)\"', block):
                    spec = m.group(1)
                    dst = spec
                    if go_module and spec.startswith(go_module):
                        dst = spec[len(go_module):].lstrip('/')
                        internal_nodes.add(dst)
                    edges_map[(src_id, dst)] = edges_map.get((src_id, dst), 0) + 1
                    nodes_set.add(dst)
                    node_meta.setdefault(dst, {}).setdefault("lang", "go")

        # Parse Java imports
        java_internal: set[str] = set()
        for f in (java_files if include_java else []):
            src = _read_text(f)
            if not src:
                continue
            pm = java_package.search(src)
            if pm:
                pkg = pm.group(1)
                java_internal.add(pkg)
                nid = pkg  # package id
                nodes_set.add(nid)
                internal_nodes.add(nid)
                node_meta.setdefault(nid, {}).setdefault("lang", "java")
        for f in (java_files if include_java else []):
            src = _read_text(f)
            if not src:
                continue
            pm = java_package.search(src)
            src_pkg = pm.group(1) if pm else _rel_id_without_ext(tmpdir, f, ['.java'], '.') or 'unknown'
            nodes_set.add(src_pkg)
            internal_nodes.add(src_pkg)
            node_meta.setdefault(src_pkg, {}).setdefault("lang", "java")
            for m in java_import.finditer(src):
                spec = m.group(1)
                dst = spec
                edges_map[(src_pkg, dst)] = edges_map.get((src_pkg, dst), 0) + 1
                nodes_set.add(dst)
                node_meta.setdefault(dst, {}).setdefault("lang", "java")
                if any(dst.startswith(p + '.') for p in cs_internal):
                    internal_nodes.add(dst)

        # Parse PHP includes/requires
        for f in (php_files if include_php else []):
            src_id = _rel_id_without_ext(tmpdir, f, ['.php'], '/')
            if not src_id:
                continue
            nodes_set.add(src_id)
            internal_nodes.add(src_id)
            src = _read_text(f)
            if not src:
                continue
            file_dir = os.path.dirname(f)
            for m in php_require.finditer(src):
                spec = (m.group(2) or '').strip()
                if not spec:
                    continue
                if spec.startswith('.') or spec.startswith('/'):
                    target = spec[1:] if spec.startswith('/') else spec
                    dst_path = os.path.normpath(os.path.join(file_dir, target))
                    dst = _rel_id_without_ext(tmpdir, dst_path, ['.php'], '/') or target
                    internal_nodes.add(dst)
                else:
                    dst = spec.split('/', 1)[0]
                    node_meta.setdefault(dst, {}).setdefault("lang", "php")
                edges_map[(src_id, dst)] = edges_map.get((src_id, dst), 0) + 1
                nodes_set.add(dst)

        # Parse Ruby requires
        for f in (rb_files if include_rb else []):
            src_id = _rel_id_without_ext(tmpdir, f, ['.rb'], '/')
            if not src_id:
                continue
            nodes_set.add(src_id)
            internal_nodes.add(src_id)
            src = _read_text(f)
            if not src:
                continue
            file_dir = os.path.dirname(f)
            for m in ruby_require_rel.finditer(src):
                relp = m.group(1)
                target = os.path.normpath(os.path.join(file_dir, relp))
                dst = _rel_id_without_ext(tmpdir, target, ['.rb'], '/') or relp
                edges_map[(src_id, dst)] = edges_map.get((src_id, dst), 0) + 1
                nodes_set.add(dst)
                internal_nodes.add(dst)
                node_meta.setdefault(dst, {}).setdefault("lang", "ruby")
            for m in ruby_require.finditer(src):
                spec = m.group(1)
                if not spec:
                    continue
                if spec.startswith('.'):
                    target = os.path.normpath(os.path.join(file_dir, spec))
                    dst = _rel_id_without_ext(tmpdir, target, ['.rb'], '/') or spec
                    internal_nodes.add(dst)
                    node_meta.setdefault(dst, {}).setdefault("lang", "ruby")
                else:
                    dst = spec.split('/', 1)[0]
                    node_meta.setdefault(dst, {}).setdefault("lang", "ruby")
                edges_map[(src_id, dst)] = edges_map.get((src_id, dst), 0) + 1
                nodes_set.add(dst)

        # Apply server-side filters: language, edge min_weight, and node cap by degree
        # 1) Language filter
        def _lang_ok(node_id: str) -> bool:
            if lang == "all":
                return True
            l = str((node_meta.get(node_id, {}) or {}).get("lang", "")).lower()
            if lang == "js":
                return l in {"js", "npm"}
            return l == lang.lower()

        filtered_nodes = {n for n in nodes_set if _lang_ok(n)}

        # 2) Edge filter (by weight and presence of filtered nodes)
        filtered_edge_items: List[tuple[str, str, int]] = []
        for (src, dst), w in edges_map.items():
            if w >= max(1, int(min_weight)) and src in filtered_nodes and dst in filtered_nodes:
                filtered_edge_items.append((src, dst, w))

        # 3) Node cap by degree (balanced internal/external)
        if node_cap and node_cap > 0:
            deg: Dict[str, int] = {}
            for s, d, _w in filtered_edge_items:
                deg[s] = deg.get(s, 0) + 1
                deg[d] = deg.get(d, 0) + 1
            internals = [n for n in filtered_nodes if n in internal_nodes]
            externals = [n for n in filtered_nodes if n not in internal_nodes]
            internals.sort(key=lambda n: deg.get(n, 0), reverse=True)
            externals.sort(key=lambda n: deg.get(n, 0), reverse=True)
            half = max(10, min(node_cap // 2, len(internals)))
            internals = internals[:half]
            externals = externals[:max(0, node_cap - len(internals))]
            kept_nodes = set(internals + externals)
            filtered_edge_items = [(s, d, w) for (s, d, w) in filtered_edge_items if s in kept_nodes and d in kept_nodes]
            filtered_nodes = kept_nodes

        # Build final nodes
        nodes: List[Dict[str, object]] = []
        for n in sorted(filtered_nodes):
            ntype = 'internal' if n in internal_nodes else 'external'
            nd = {"id": n, "label": n, "type": ntype}
            if n in node_meta:
                nd["meta"] = node_meta[n]
            nodes.append(nd)

        # Build final edges
        edges: List[Dict[str, object]] = []
        for (src, dst, w) in filtered_edge_items:
            edges.append({"source": src, "target": dst, "weight": w})

        stats = {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "internal_nodes": sum(1 for n in nodes if n["type"] == 'internal'),
            "external_nodes": sum(1 for n in nodes if n["type"] == 'external'),
        }

        resp = ArchGraphResponse(nodes=nodes, edges=edges, stats=stats)
        _cache_set(_ARCH_CACHE, cache_key, resp.model_dump())
        return resp
    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Architecture graph timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to build architecture graph: {e}")
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


# ----------------------------
# Community Health
# ----------------------------

class CommunityResponse(BaseModel):
    contributing: bool
    code_of_conduct: bool
    security: bool
    support: bool
    funding: bool
    codeowners: bool
    issue_templates: bool
    pr_template: bool
    docs_dir: bool
    discussions_enabled: Optional[bool] = None
    score: int
    missing: List[str]


def _exists_any(owner: str, name: str, paths: List[str]) -> bool:
    for p in paths:
        if _fetch_repo_text_file(owner, name, p) is not None:
            return True
    return False


@app.get("/api/repo/{owner}/{name}/community", response_model=CommunityResponse)
def community(owner: str, name: str):
    try:
        contributing = _exists_any(owner, name, ["CONTRIBUTING.md", ".github/CONTRIBUTING.md"]) or False
        coc = _exists_any(owner, name, ["CODE_OF_CONDUCT.md", ".github/CODE_OF_CONDUCT.md"]) or False
        sec = _exists_any(owner, name, ["SECURITY.md", ".github/SECURITY.md"]) or False
        support = _exists_any(owner, name, ["SUPPORT.md", ".github/SUPPORT.md"]) or False
        funding = _exists_any(owner, name, [".github/FUNDING.yml"]) or False
        codeowners = _exists_any(owner, name, ["CODEOWNERS", ".github/CODEOWNERS"]) or False
        issue_templates = len(_list_repo_dir(owner, name, ".github/ISSUE_TEMPLATE")) > 0
        pr_template = _exists_any(owner, name, [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md"]) or False
        # docs directory presence
        docs_dir = len(_list_repo_dir(owner, name, "docs")) > 0

        discussions_enabled: Optional[bool] = None
        try:
            with httpx.Client(timeout=6.0, follow_redirects=True) as client:
                repo_resp = client.get(f"https://api.github.com/repos/{owner}/{name}", headers=_gh_headers())
                if repo_resp.status_code == 200:
                    r = repo_resp.json()
                    if isinstance(r, dict) and "has_discussions" in r:
                        discussions_enabled = bool(r.get("has_discussions"))
        except Exception:
            discussions_enabled = None

        checks = {
            "contributing": contributing,
            "code_of_conduct": coc,
            "security": sec,
            "support": support,
            "funding": funding,
            "codeowners": codeowners,
            "issue_templates": issue_templates,
            "pr_template": pr_template,
            "docs_dir": docs_dir,
        }
        present = sum(1 for v in checks.values() if v)
        total = len(checks)
        score = int(round(100 * present / max(1, total)))
        missing = [k for k, v in checks.items() if not v]
        return CommunityResponse(
            contributing=contributing,
            code_of_conduct=coc,
            security=sec,
            support=support,
            funding=funding,
            codeowners=codeowners,
            issue_templates=issue_templates,
            pr_template=pr_template,
            docs_dir=docs_dir,
            discussions_enabled=discussions_enabled,
            score=score,
            missing=missing,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Community check failed: {e}")


# ----------------------------
# Security
# ----------------------------

class SecurityResponse(BaseModel):
    dependabot_config: bool
    codeql_workflow: bool
    branch_protection_enabled: Optional[bool] = None
    risk_score: int
    findings: List[str]


@app.get("/api/repo/{owner}/{name}/security", response_model=SecurityResponse)
def security(owner: str, name: str):
    try:
        # Dependabot config
        dependabot = _exists_any(owner, name, [".github/dependabot.yml", ".github/dependabot.yaml"]) or False

        # CodeQL workflow
        workflows = _list_repo_dir(owner, name, ".github/workflows")
        codeql_workflow = any(re.search(r"codeql|code-?ql", w, re.I) for w in workflows)

        # Branch protection (best effort; requires token for private repos and may 403)
        branch_protection: Optional[bool] = None
        try:
            headers = _gh_headers()
            with httpx.Client(timeout=6.0, follow_redirects=True) as client:
                repo_resp = client.get(f"https://api.github.com/repos/{owner}/{name}", headers=headers)
                repo_resp.raise_for_status()
                default_branch = (repo_resp.json() or {}).get("default_branch", "main")
                prot_resp = client.get(f"https://api.github.com/repos/{owner}/{name}/branches/{default_branch}/protection", headers=headers)
                if prot_resp.status_code == 200:
                    branch_protection = True
                elif prot_resp.status_code in (401, 403, 404):
                    branch_protection = None  # unknown
        except Exception:
            branch_protection = None

        # Simple risk score: start at 100 and penalize missing controls
        risk = 100
        findings: List[str] = []
        if not dependabot:
            risk -= 25; findings.append("No dependabot configuration found (.github/dependabot.yml)")
        if not codeql_workflow:
            risk -= 35; findings.append("No CodeQL workflow detected in .github/workflows")
        if branch_protection is False:
            risk -= 30; findings.append("Default branch has no protection rules")
        elif branch_protection is None:
            findings.append("Branch protection status unknown (insufficient permissions or not configured)")

        risk = max(0, min(100, risk))
        return SecurityResponse(
            dependabot_config=dependabot,
            codeql_workflow=codeql_workflow,
            branch_protection_enabled=branch_protection,
            risk_score=risk,
            findings=findings,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Security check failed: {e}")


@app.get("/api/repo/{owner}/{name}/community-badge.svg")
def community_badge(owner: str, name: str):
    try:
        resp = community(owner, name)
        score = resp.score
        level = 'green' if score >= 80 else ('yellow' if score >= 50 else 'red')
        color = { 'green': '#10b981', 'yellow': '#f59e0b', 'red': '#ef4444' }[level]
        label = "community"
        value = f"{score}/100"
        left_w = 80
        right_w = 70
        total_w = left_w + right_w
        svg = f"""
<svg xmlns='http://www.w3.org/2000/svg' width='{total_w}' height='20' role='img' aria-label='{label}: {value}'>
  <linearGradient id='s' x2='0' y2='100%'>
    <stop offset='0' stop-color='#bbb' stop-opacity='.1'/>
    <stop offset='1' stop-opacity='.1'/>
  </linearGradient>
  <mask id='m'><rect width='{total_w}' height='20' rx='3' fill='#fff'/></mask>
  <g mask='url(#m)'>
    <rect width='{left_w}' height='20' fill='#555'/>
    <rect x='{left_w}' width='{right_w}' height='20' fill='{color}'/>
    <rect width='{total_w}' height='20' fill='url(#s)'/>
  </g>
  <g fill='#fff' text-anchor='middle' font-family='DejaVu Sans,Verdana,Geneva,sans-serif' font-size='11'>
    <text x='{left_w/2}' y='15'>{label}</text>
    <text x='{left_w + right_w/2}' y='15'>{value}</text>
  </g>
</svg>
"""
        from fastapi.responses import Response
        return Response(content=svg, media_type="image/svg+xml")
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Unable to render community badge: {e}")


@app.get("/api/repo/{owner}/{name}/security-badge.svg")
def security_badge(owner: str, name: str):
    try:
        resp = security(owner, name)
        score = resp.risk_score
        level = 'green' if score >= 80 else ('yellow' if score >= 50 else 'red')
        color = { 'green': '#10b981', 'yellow': '#f59e0b', 'red': '#ef4444' }[level]
        label = "security"
        value = f"{score}/100"
        left_w = 70
        right_w = 70
        total_w = left_w + right_w
        svg = f"""
<svg xmlns='http://www.w3.org/2000/svg' width='{total_w}' height='20' role='img' aria-label='{label}: {value}'>
  <linearGradient id='s' x2='0' y2='100%'>
    <stop offset='0' stop-color='#bbb' stop-opacity='.1'/>
    <stop offset='1' stop-opacity='.1'/>
  </linearGradient>
  <mask id='m'><rect width='{total_w}' height='20' rx='3' fill='#fff'/></mask>
  <g mask='url(#m)'>
    <rect width='{left_w}' height='20' fill='#555'/>
    <rect x='{left_w}' width='{right_w}' height='20' fill='{color}'/>
    <rect width='{total_w}' height='20' fill='url(#s)'/>
  </g>
  <g fill='#fff' text-anchor='middle' font-family='DejaVu Sans,Verdana,Geneva,sans-serif' font-size='11'>
    <text x='{left_w/2}' y='15'>{label}</text>
    <text x='{left_w + right_w/2}' y='15'>{value}</text>
  </g>
</svg>
"""
        from fastapi.responses import Response
        return Response(content=svg, media_type="image/svg+xml")
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Unable to render security badge: {e}")


# ----------------------------
# File Hotspots (git history)
# ----------------------------

class HotspotAuthor(BaseModel):
    login: Optional[str] = None
    commits: int


class HotspotItem(BaseModel):
    path: str
    changes: int
    last_modified: Optional[str] = None
    top_authors: List[HotspotAuthor] = []


class HotspotsResponse(BaseModel):
    items: List[HotspotItem]


@app.get("/api/repo/{owner}/{name}/hotspots", response_model=HotspotsResponse)
def hotspots(owner: str, name: str, limit_commits: int = 1500, max_items: int = 100):
    # Resolve latest commit for cache key
    try:
        headers = _gh_headers()
        with httpx.Client(timeout=8.0) as client:
            repo_resp = client.get(f"https://api.github.com/repos/{owner}/{name}", headers=headers)
            if repo_resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Repository not found.")
            repo_resp.raise_for_status()
            rj = repo_resp.json()
            default_branch = rj.get("default_branch", "main")
            br_resp = client.get(f"https://api.github.com/repos/{owner}/{name}/branches/{default_branch}", headers=headers)
            last_sha = None
            if br_resp.status_code == 200:
                last_sha = (br_resp.json() or {}).get("commit", {}).get("sha")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to resolve default branch: {e}")

    cache_key = f"{owner}/{name}@{last_sha or 'unknown'}:{limit_commits}:{max_items}"
    cached = _cache_get(_HOTSPOT_CACHE, cache_key)
    if cached:
        return HotspotsResponse(**cached)

    tmpdir = tempfile.mkdtemp(prefix="hotspots_")
    try:
        repo_url = f"https://github.com/{owner}/{name}.git"
        code, out, err = _run(["git", "clone", "--depth", "1", "--no-single-branch", repo_url, tmpdir], timeout=120)
        if code != 0:
            raise HTTPException(status_code=502, detail=f"git clone failed: {err or out}")

        # Get recent history with filenames. Limit to avoid heavy processing.
        # Format: SHA<TAB>ISO8601<TAB>AuthorName then file paths lines until blank between commits.
        log_format = "%H%x09%aI%x09%an"
        code_log, out_log, err_log = _run([
            "git", "log", f"-n", str(max(100, min(5000, limit_commits))), f"--pretty=format:{log_format}", "--name-only"
        ], cwd=tmpdir, timeout=120)
        if code_log != 0:
            raise HTTPException(status_code=502, detail=f"git log failed: {err_log or out_log}")

        changes: Dict[str, int] = {}
        last_modified: Dict[str, str] = {}
        authors: Dict[str, Dict[str, int]] = {}  # path -> author -> commits

        current_author = None
        current_date = None
        for line in out_log.splitlines():
            if not line.strip():
                continue
            if '\t' in line:
                # header line
                try:
                    _, date_iso, author = line.split('\t', 2)
                except ValueError:
                    # In rare cases author may contain tabs; fall back
                    parts = line.split('\t')
                    date_iso = parts[1] if len(parts) > 1 else None
                    author = parts[2] if len(parts) > 2 else None
                current_author = author
                current_date = date_iso
                continue
            # filename line
            path = line.strip()
            if not path or path.endswith('/'):
                continue
            # Skip generated/lock files noise
            if any(path.endswith(suf) for suf in [".lock", ".min.js", ".min.css"]):
                continue
            changes[path] = changes.get(path, 0) + 1
            if current_date:
                # Keep most recent modification
                if (path not in last_modified) or (last_modified[path] < current_date):
                    last_modified[path] = current_date
            if current_author:
                m = authors.setdefault(path, {})
                m[current_author] = m.get(current_author, 0) + 1

        # Build response items
        items = []
        for p, cnt in changes.items():
            auth_map = authors.get(p, {})
            top = sorted(auth_map.items(), key=lambda kv: kv[1], reverse=True)[:3]
            items.append({
                "path": p,
                "changes": cnt,
                "last_modified": last_modified.get(p),
                "top_authors": [{"login": a or None, "commits": c} for a, c in top]
            })

        items.sort(key=lambda it: it["changes"], reverse=True)
        items = items[:max(20, min(200, max_items))]
        resp = HotspotsResponse(items=[HotspotItem(**it) for it in items])
        _cache_set(_HOTSPOT_CACHE, cache_key, resp.model_dump())
        return resp
    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Hotspot analysis timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Hotspot analysis failed: {e}")
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass
