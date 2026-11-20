#!/usr/bin/env python3
"""Prepare the Android core's offline datasets from the shared resource lock."""
import argparse
import json
import os
from pathlib import Path
import runpy
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FETCH = runpy.run_path(str(ROOT / 'scripts/prepare-resources.py'))['fetch']
NAMES = ('geosite.dat', 'geoip.dat', 'geoip.metadb', 'ASN.mmdb')


def prepare(lock, output, cache):
    # country.mmdb is an alternative to geoip.metadb; Android only needs one MMDB.
    entries = {name: FETCH(lock['geodata'][name], cache) for name in NAMES}
    manifest = {name: {'sha256': lock['geodata'][name]['sha256'], 'size': len(data)}
                for name, data in entries.items()}
    entries['manifest.json'] = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix='.zip', delete=False) as stage:
        staged = Path(stage.name)
    try:
        with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(entries.items()):
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
        staged.replace(output)
    finally:
        staged.unlink(missing_ok=True)
    print(f'Prepared Android offline geodata: {output.stat().st_size / 1024 / 1024:.1f} MiB')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/android-core/mobile/geodata.zip')
    parser.add_argument('--cache', type=Path, default=Path(os.environ.get('PPCLASH_RESOURCE_CACHE', str(Path.home() / '.cache/ppclash/resources'))))
    args = parser.parse_args()
    prepare(json.loads((ROOT / 'scripts/resources.lock.json').read_text()), args.output, args.cache)
