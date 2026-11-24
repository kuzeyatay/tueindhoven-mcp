"""Build release ZIPs from an explicit file list after npm test (Python 3.10+)."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NODE_VERSION = "v24.22.3"
NODE_SHA256 = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f"
parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
version = json.loads((ROOT / "package.json").read_text())["version"]
prefix = f"tueindhoven-mcp-{version}"


def archive(stage, filename):
    dest = output / filename
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for file in sorted(stage.rglob("*")):
            if file.is_file():
                relative = file.relative_to(stage)
                name = f"{prefix}/{relative.as_posix()}"
                if file.suffix == ".command":
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = 0o100755 << 16
                    bundle.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
                else:
                    bundle.write(file, name)
    return dest


with tempfile.TemporaryDirectory() as directory:
    tmp = Path(directory)
    stage = tmp / "app"
    stage.mkdir()
    for file in ("README.md", "LICENSE", "package.json", "package-lock.json"):
        shutil.copy2(ROOT / file, stage / file)
    for folder in ("dist", "assets"):
        shutil.copytree(ROOT / folder, stage / folder)
    subprocess.run([shutil.which("npm.cmd") or "npm", "ci", "--omit=dev", "--ignore-scripts",
                    "--no-audit", "--no-fund"], cwd=stage, check=True)
    for label, cmd in (("Setup", "dist/cli.js install"), ("Sign in", "dist/cli.js connect"),
                       ("Check connections", "dist/verify.js")):
        # These fixed arguments never contain user input.
        sh = stage / f"{label}.command"
        sh.write_text('#!/bin/sh\ncd "$(dirname "$0")" || exit 1\n'
                      'if ! command -v node >/dev/null; then echo "Install Node.js LTS from nodejs.org, then reopen this file."; '
                      'else node ' + cmd + '; fi\nprintf "\\nPress Enter to close. "; read -r answer\n', encoding="utf8")
        sh.chmod(0o755)
    portable = archive(stage, prefix + "-portable.zip")
    for file in stage.glob("*.command"):
        file.unlink()
    resource = f"node-{NODE_VERSION}-win-x64"
    node_zip = tmp / "runtime.zip"
    urllib.request.urlretrieve(f"https://nodejs.org/dist/{NODE_VERSION}/{resource}.zip", node_zip)
    if hashlib.sha256(node_zip.read_bytes()).hexdigest() != NODE_SHA256:
        raise RuntimeError("Node.js runtime checksum mismatch")
    with zipfile.ZipFile(node_zip) as node:
        for src, dst in (("node.exe", "node.exe"), ("LICENSE", "LICENSE-Node.txt")):
            with node.open(f"{resource}/{src}") as in_file, (stage / dst).open("wb") as out_file:
                shutil.copyfileobj(in_file, out_file)
    for label, cmd in (("Setup", "dist/cli.js install"), ("Sign in", "dist/cli.js connect"),
                       ("Check connections", "dist/verify.js")):
        (stage / f"{label}.cmd").write_bytes(('@echo off\r\ncd /d "%~dp0"\r\n'
            + '"%~dp0node.exe" ' + cmd + '\r\nset "result=%errorlevel%"\r\npause\r\nexit /b %result%\r\n').encode())
    windows = archive(stage, prefix + "-windows-x64.zip")
    (output / "SHA256SUMS.txt").write_text("".join(
        f"{hashlib.sha256(z.read_bytes()).hexdigest()}  {z.name}\n" for z in (portable, windows)),
        encoding="ascii")
    print(portable.name, windows.name)
