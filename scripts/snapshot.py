#!/usr/bin/env python3
"""Offline SQLite snapshot helper. Caller MUST stop the only writer first.
Archives are sensitive: encrypted records still include metadata and session hashes.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile

FILES = {"rememberkey.sqlite", "rememberkey.sqlite-wal", "rememberkey.sqlite-shm"}
MAX_SIZE = 10 * 1024**3


def validate(directory):
    db = directory / "rememberkey.sqlite"
    if not db.is_file() or db.is_symlink():
        raise ValueError("Snapshot must contain rememberkey.sqlite")
    with sqlite3.connect(db.as_uri() + "?mode=rw", uri=True) as conn:
        result = conn.execute("PRAGMA integrity_check").fetchall()
        if result != [("ok",)]:
            raise ValueError("SQLite integrity_check failed")
        expected = {"accounts", "devices", "records", "operations", "changes"}
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not expected <= tables:
            raise ValueError("Not a rememberKey database")


def backup(data, archive):
    if archive.exists() or archive.is_symlink():
        raise ValueError("Refusing to overwrite existing archive")
    archive.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Copy every SQLite sidecar while writer is stopped; validate/checkpoint ONLY the copy.
    with tempfile.TemporaryDirectory(prefix="rk-snapshot-", dir=archive.parent) as tmp:
        stage = Path(tmp)
        for name in FILES:
            source = data / name
            if source.is_symlink():
                raise ValueError("Refusing database symlink")
            if source.exists():
                shutil.copyfile(source, stage / name)
        validate(stage)
        # Use SQLite backup API to consolidate any surviving WAL into one portable DB.
        portable = stage / "portable.sqlite"
        with sqlite3.connect(stage / "rememberkey.sqlite") as src, sqlite3.connect(portable) as dest:
            src.backup(dest)
        try:
            with archive.open("xb") as out:
                os.chmod(archive, 0o600)
                with tarfile.open(fileobj=out, mode="w:gz") as tar:
                    tar.add(portable, arcname="rememberkey.sqlite", recursive=False)
        except BaseException:
            if archive.is_file():
                archive.unlink()
            raise
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix + ".sha256").write_text(checksum + "\n", encoding="ascii")
    print(f"Backup: {archive}")


def restore(data, archive):
    # Archive must be independently authenticated by the operator. Integrity != authenticity.
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("Archive must be a regular file")
    if data.is_symlink() or not data.is_dir():
        raise ValueError("Data directory must be a real directory")
    with tempfile.TemporaryDirectory(prefix="rk-restore-", dir=data.parent) as tmp:
        stage = Path(tmp)
        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getmembers()
            if len(members) != 1 or members[0].name != "rememberkey.sqlite" or not members[0].isfile():
                raise ValueError("Archive must contain exactly one regular rememberkey.sqlite; links/paths rejected")
            if members[0].size > MAX_SIZE:
                raise ValueError("Database exceeds restore limit (10 GiB)")
            with tar.extractfile(members[0]) as src, (stage / "rememberkey.sqlite").open("xb") as dest:
                shutil.copyfileobj(src, dest)
        validate(stage)
        # Old sessions are not safe to resurrect. Force reauthentication after restore.
        with sqlite3.connect(stage / "rememberkey.sqlite") as db:
            for table in ("access_tokens", "refresh_tokens", "families", "challenges"):
                db.execute(f"DELETE FROM {table}")
            db.commit()
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            db.execute("PRAGMA journal_mode=DELETE")
        target = data / "rememberkey.sqlite"
        for name in FILES:
            p = data / name
            if p.is_symlink() or (p.exists() and not p.is_file()):
                raise ValueError("Refusing non-regular existing database file")
        # Explicit, checked targets only. Caller has already created pre-restore backup.
        for name in FILES - {"rememberkey.sqlite"}:
            (data / name).unlink(missing_ok=True)
        os.chmod(stage / "rememberkey.sqlite", 0o600)
        os.chown(stage / "rememberkey.sqlite", 10001, 10001)
        os.replace(stage / "rememberkey.sqlite", target)
    print("Database restored; sessions revoked. Start app and sign in again.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("backup", "restore"))
    parser.add_argument("data", type=Path)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    data = args.data.absolute()
    archive = args.archive.absolute()
    if data.is_symlink():
        raise ValueError("Refusing data directory symlink")
    (backup if args.action == "backup" else restore)(data, archive)


if __name__ == "__main__":
    main()
