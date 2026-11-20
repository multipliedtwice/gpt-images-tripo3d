#!/usr/bin/env python3
import argparse
import io
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_FILES = (
    "archive.js",
    "assets/icon-16.png",
    "assets/icon-32.png",
    "assets/icon-48.png",
    "assets/icon-128.png",
    "assets/icon.svg",
    "background.js",
    "content-gpt.js",
    "content.js",
    "dashboard.html",
    "dashboard.js",
    "db.js",
    "files.js",
    "gpt.js",
    "manifest.json",
    "mcp-client.js",
    "mcp-tools.js",
    "page-capture.js",
    "queue-status.js",
    "remote-folder.js",
    "styles.css",
    "transfer.js",
    "util.js",
)
HELPER_FILES = (
    "mcp/bridge.js",
    "mcp/broker.js",
    "mcp/client.js",
    "mcp/folder.js",
    "mcp/server.js",
    "mcp-tools.js",
)


def source_bytes(name):
    path = ROOT / name
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT):
        raise ValueError(f"Required release source must be a project file: {name}")
    return path.read_bytes()


def zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, contents in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, contents, compresslevel=9)
    return output.getvalue()


def write_atomic(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(contents)
        temporary.chmod(0o644)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def package_release(output):
    manifest = json.loads(source_bytes("manifest.json"))
    package = json.loads(source_bytes("package.json"))
    version = manifest.get("version")
    if version != package.get("version"):
        raise ValueError("manifest.json and package.json versions must match.")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", version):
        raise ValueError("Release version must have three or four numeric components.")
    extension = {name: source_bytes(name) for name in EXTENSION_FILES}
    dashboard = extension["dashboard.html"].decode("utf-8")
    headers = re.findall(r'<span\s+class="version">\s*([^<]*?)\s*</span>', dashboard)
    links = re.findall(r'<a\b[^>]*\bhref="assets/mcp-helper\.zip"[^>]*>', dashboard)
    download = re.search(r'\bdownload="([^"]+)"', links[0]) if len(links) == 1 else None
    if headers != [f"v{version}"]:
        raise ValueError("dashboard.html version label must match the manifest version.")
    if download is None or download.group(1) != f"gpt-images-tripo3d-mcp-{version}.zip":
        raise ValueError("dashboard.html bundled helper download filename must match the manifest version.")
    helper = {name: source_bytes(name) for name in HELPER_FILES}
    helper["package.json"] = (json.dumps({
        "name": "gpt-images-tripo3d-mcp",
        "version": version,
        "private": True,
        "type": "module",
        "engines": {"node": ">=20"},
    }, indent=2) + "\n").encode("utf-8")
    helper["README.md"] = source_bytes("mcp/README.md").replace(b"@VERSION@", version.encode("ascii"))
    helper_zip = zip_bytes(helper)
    extension["assets/mcp-helper.zip"] = helper_zip
    extension_zip = zip_bytes(extension)
    outputs = (
        (output / "assets/mcp-helper.zip", helper_zip),
        (output / f"store/gpt-images-tripo3d-mcp-{version}.zip", helper_zip),
        (output / f"store/gpt-images-tripo3d-{version}.zip", extension_zip),
    )
    for path, contents in outputs:
        write_atomic(path, contents)
    return [path for path, _ in outputs]


def main():
    parser = argparse.ArgumentParser(description="Package matching extension and Node MCP helper releases.")
    parser.add_argument("--output-dir", type=Path, default=ROOT, help="Output root for assets/ and store/; defaults to project root.")
    args = parser.parse_args()
    try:
        for path in package_release(args.output_dir.resolve()):
            print(path)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Release packaging failed: {error}\n")


if __name__ == "__main__":
    main()
