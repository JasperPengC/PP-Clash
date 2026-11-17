"""跨架构准备资源只处理字节，验证缓存、架构和失败时不覆盖旧包。"""
import gzip
import hashlib
import io
import pathlib
import runpy
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from test_resource_bundle import binary, GEO

PREP = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / 'prepare-resources.py'))


class PrepareTests(unittest.TestCase):
    def test_all_six_bundles_are_deterministic_and_matching(self):
        for os_name in ['macos', 'windows', 'linux']:
            for arch in ['x86_64', 'aarch64']:
                with self.subTest(os=os_name, arch=arch), tempfile.TemporaryDirectory() as tmp:
                    root = pathlib.Path(tmp)
                    payload = binary(os_name, arch)
                    if os_name == 'windows':
                        stream = io.BytesIO()
                        with zipfile.ZipFile(stream, 'w') as z: z.writestr('mihomo.exe', payload)
                        packed = stream.getvalue()
                    else:
                        packed = gzip.compress(payload)
                    blobs = {'kernel': packed, **{name: bytes(size) for name,size in GEO.items()}}
                    items = {name: {'url':'https://github.com/MetaCubeX/test/'+name, 'sha256':hashlib.sha256(data).hexdigest()} for name,data in blobs.items()}
                    lock = {'kernelVersion':'v1.2.3','kernels':{os_name+'/'+arch:items.pop('kernel')},'geodata':items}
                    def download(request, timeout): return io.BytesIO(blobs[request.full_url.rsplit('/',1)[-1]])
                    output = root/'kernel.zip'
                    with patch('urllib.request.urlopen', side_effect=download) as fetch:
                        one = PREP['prepare'](lock,os_name,arch,output,root/'cache')
                        first = output.read_bytes()
                        two = PREP['prepare'](lock,os_name,arch,output,root/'cache')
                        self.assertEqual(fetch.call_count, len({i['sha256'] for i in [lock['kernels'][os_name+'/'+arch],*items.values()]}))
                    self.assertEqual(one,two)
                    self.assertEqual(first,output.read_bytes())
                    PREP['GATE']['validate_bundle'](output,os_name,arch,one)

    def test_corrupt_download_or_wrong_architecture_preserves_previous_bundle(self):
        for bad in ['hash','arch']:
            with tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp); output = root/'kernel.zip';output.write_bytes(b'previous bundle')
                payload = gzip.compress(binary('linux','aarch64'))
                digest = '0'*64 if bad == 'hash' else hashlib.sha256(payload).hexdigest()
                item = {'url':'https://github.com/MetaCubeX/test/kernel','sha256':digest}
                lock = {'kernelVersion':'v1.2.3','kernels':{'linux/x86_64':item},'geodata':{}}
                with patch('urllib.request.urlopen', return_value=io.BytesIO(payload)):
                    with self.assertRaises(ValueError): PREP['prepare'](lock,'linux','x86_64',output,root/'cache')
                self.assertEqual(output.read_bytes(),b'previous bundle')
                self.assertFalse(output.with_suffix('.zip.sha256').exists())

    def test_tampered_cache_is_replaced_only_by_verified_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache=pathlib.Path(tmp);data=b'verified';digest=hashlib.sha256(data).hexdigest()
            (cache/digest).write_bytes(b'tampered')
            item={'url':'https://github.com/MetaCubeX/test/file','sha256':digest}
            with patch('urllib.request.urlopen',return_value=io.BytesIO(data)):
                self.assertEqual(PREP['fetch'](item,cache),data)
            self.assertEqual((cache/digest).read_bytes(),data)

if __name__ == '__main__': unittest.main()
