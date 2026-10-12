#!/usr/bin/env bash
set -euo pipefail
source /workspace/.toolchains/android-env.sh
mkdir -p /workspace/.toolchains/avd /workspace/.toolchains/emulator-home /workspace/.toolchains/xdg-cache
export ANDROID_AVD_HOME=/workspace/.toolchains/avd
export ANDROID_EMULATOR_HOME=/workspace/.toolchains/emulator-home
export XDG_CACHE_HOME=/workspace/.toolchains/xdg-cache
python3 - <<'PY'
import os,subprocess,urllib.parse,pathlib
args=[os.environ['ANDROID_HOME']+'/cmdline-tools/19.0/bin/sdkmanager','--sdk_root='+os.environ['ANDROID_HOME'],'emulator','system-images;android-35;default;x86_64']
proxy=urllib.parse.urlsplit(os.environ.get('HTTPS_PROXY',''))
if proxy.hostname:
    args+=['--proxy=http','--proxy_host='+proxy.hostname,'--proxy_port='+str(proxy.port or 80)]
subprocess.run(args,input='y\n'*20,text=True,check=True)
path=pathlib.Path('/workspace/.toolchains/avd/MyScan35.ini')
if not path.exists():
    subprocess.run([os.environ['ANDROID_HOME']+'/cmdline-tools/19.0/bin/avdmanager','create','avd','--name','MyScan35','--package','system-images;android-35;default;x86_64','--device','pixel_6','--path','/workspace/.toolchains/avd/MyScan35.avd'],input='no\n',text=True,check=True)
PY
