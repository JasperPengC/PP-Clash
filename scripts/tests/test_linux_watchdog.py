"""看门狗使用假的 gsettings，仅验证所属代理的清理，不接触宿主代理。"""
import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT=pathlib.Path(__file__).resolve().parents[2]/'src-tauri/src/watchdog-linux.sh'

@unittest.skipIf(os.name=='nt','POSIX shell fixture')
class LinuxWatchdogTests(unittest.TestCase):
    def test_only_our_http_and_https_proxy_is_disabled(self):
        for host,port,https_port,mode,expected in [
            ("127.0.0.1","7890","7890","manual",True),
            ("127.0.0.1","8888","8888","manual",False),
            ("other-app","7890","7890","manual",False),
            ("127.0.0.1","7890","8888","manual",False),
            ("127.0.0.1","7890","7890","auto",False),
        ]:
            with tempfile.TemporaryDirectory() as tmp:
                root=pathlib.Path(tmp);(root/'watchdog.port').write_text('7890')
                fake=root/'gsettings';trace=root/'trace'
                fake.write_text('''#!/bin/sh
if [ "$1" = set ]; then printf '%s\\n' "$*" >> "$FIXTURE_TRACE"; exit; fi
case "$3" in
mode) printf "'%s'\\n" "$FIXTURE_MODE" ;;
host) printf "'%s'\\n" "$FIXTURE_HOST" ;;
port) if [ "$2" = org.gnome.system.proxy.https ]; then printf '%s\\n' "$FIXTURE_HTTPS_PORT"; else printf '%s\\n' "$FIXTURE_PORT"; fi ;;
esac
''');fake.chmod(0o755)
                env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH'],'XDG_CURRENT_DESKTOP':'GNOME','FIXTURE_HOST':host,'FIXTURE_PORT':port,'FIXTURE_HTTPS_PORT':https_port,'FIXTURE_MODE':mode,'FIXTURE_TRACE':str(trace)}
                result=subprocess.run(['sh',str(SCRIPT),'2147483647',str(root)],env=env,capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(trace.exists(),expected)
                if expected:self.assertEqual(trace.read_text().strip(),'set org.gnome.system.proxy mode none')

if __name__=='__main__':unittest.main()
