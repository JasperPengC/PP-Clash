"""Android must bundle verified offline data without a desktop executable."""
import hashlib
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / 'prepare-android-geodata.py'


class AndroidGeodataTests(unittest.TestCase):
    def test_locked_data_is_complete_deterministic_and_cached(self):
        self.assertTrue(SCRIPT.is_file(), 'Android has no offline geodata preparation')
        prepare = runpy.run_path(str(SCRIPT))['prepare']
        names = ['geosite.dat', 'geoip.dat', 'geoip.metadb', 'ASN.mmdb']
        blobs = {name: (name.encode() + b'fixture') * 5 for name in names}
        lock = {'geodata': {name: {'url': 'https://github.com/MetaCubeX/test/' + name,
            'sha256': hashlib.sha256(data).hexdigest()} for name, data in blobs.items()}}
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'geodata.zip'
            with patch('urllib.request.urlopen', side_effect=lambda request, timeout: io.BytesIO(blobs[request.full_url.rsplit('/', 1)[-1]])) as fetch:
                prepare(lock, target, Path(tmp) / 'cache')
                first = target.read_bytes()
                prepare(lock, target, Path(tmp) / 'cache')
                self.assertEqual(first, target.read_bytes())
                self.assertEqual(fetch.call_count, 4)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(set(archive.namelist()), set(names + ['manifest.json']))
                manifest = json.loads(archive.read('manifest.json'))
                for name, data in blobs.items():
                    self.assertEqual(archive.read(name), data)
                    self.assertEqual(manifest[name], {'sha256': lock['geodata'][name]['sha256'], 'size': len(data)})

    def test_bad_download_does_not_replace_a_valid_bundle(self):
        self.assertTrue(SCRIPT.is_file(), 'Android has no offline geodata preparation')
        prepare = runpy.run_path(str(SCRIPT))['prepare']
        lock = {'geodata': {name: {'url': 'https://github.com/MetaCubeX/test/' + name, 'sha256': '0' * 64}
            for name in ['geosite.dat', 'geoip.dat', 'geoip.metadb', 'ASN.mmdb']}}
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'geodata.zip'
            target.write_bytes(b'previous verified bundle')
            with patch('urllib.request.urlopen', return_value=io.BytesIO(b'corrupt')):
                with self.assertRaises(ValueError): prepare(lock, target, Path(tmp) / 'cache')
            self.assertEqual(target.read_bytes(), b'previous verified bundle')


if __name__ == '__main__': unittest.main()
