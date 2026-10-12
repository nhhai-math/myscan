#!/usr/bin/env bash
set -euo pipefail
# Debian 13 cloud workspace installation; existing checkouts are used in place.
task_toolchain_root=/workspace/.toolchains
mkdir -p "$task_toolchain_root"/{downloads,gradle-home,android-user,android-sdk/cmdline-tools,apt/lists/partial,apt/cache/archives/partial,apt/etc/apt.conf.d}
cat > "$task_toolchain_root/apt/etc/sources.list" <<'SOURCES'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://security.debian.org/debian-security trixie-security main
SOURCES
cat > "$task_toolchain_root/apt/apt.conf" <<'APTCONF'
Dir::Etc::sourceparts "-";
Dir::Etc::sourcelist "/workspace/.toolchains/apt/etc/sources.list";
Dir::Etc::parts "/workspace/.toolchains/apt/etc/apt.conf.d";
Dir::State::lists "/workspace/.toolchains/apt/lists";
Dir::Cache "/workspace/.toolchains/apt/cache";
Dir::Log "/workspace/.toolchains/apt/log";
APT::Sandbox::User "agent";
APT::Update::Error-Mode "any";
APTCONF
if ! test -x "$task_toolchain_root/java21/usr/lib/jvm/java-21-openjdk-amd64/bin/javac"; then
  APT_CONFIG="$task_toolchain_root/apt/apt.conf" /usr/bin/apt-get update
  (cd "$task_toolchain_root/downloads"; APT_CONFIG="$task_toolchain_root/apt/apt.conf" /usr/bin/apt-get download openjdk-21-jdk-headless openjdk-21-jre-headless)
  python3 - <<'PY'
from pathlib import Path
import subprocess,hashlib,os
root=Path('/workspace/.toolchains')
env=dict(os.environ,APT_CONFIG=str(root/'apt/apt.conf'))
for package in ['openjdk-21-jdk-headless','openjdk-21-jre-headless']:
    metadata=subprocess.check_output(['/usr/bin/apt-cache','show',package],env=env,text=True)
    stanza=metadata.split('\n\n')[0]
    version=next(line.removeprefix('Version: ') for line in stanza.splitlines() if line.startswith('Version: '))
    expected=next(line.removeprefix('SHA256: ') for line in stanza.splitlines() if line.startswith('SHA256: '))
    archive=root/'downloads'/f'{package}_{version}_amd64.deb'
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=expected:
        raise SystemExit('Package verification failed: '+archive.name)
    subprocess.run(['dpkg-deb','-x',str(archive),str(root/'java21')],check=True)
PY
fi
if ! test -f "$task_toolchain_root/downloads/gradle-8.13-bin.zip"; then
  curl --fail --location --show-error --silent --max-time 300 https://downloads.gradle.org/distributions/gradle-8.13-bin.zip -o "$task_toolchain_root/downloads/gradle-8.13-bin.zip"
fi
printf '%s  %s\n' 20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78 "$task_toolchain_root/downloads/gradle-8.13-bin.zip" | sha256sum --check
if ! test -x "$task_toolchain_root/gradle-8.13/bin/gradle"; then
  unzip -q "$task_toolchain_root/downloads/gradle-8.13-bin.zip" -d "$task_toolchain_root"
fi
if ! test -f "$task_toolchain_root/downloads/commandlinetools-linux-13114758_latest.zip"; then
  curl --fail --location --show-error --silent --max-time 300 https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o "$task_toolchain_root/downloads/commandlinetools-linux-13114758_latest.zip"
fi
# SHA-1 is the checksum published in Google's HTTPS repository2-3.xml for cmdline-tools19.0.
printf '%s  %s\n' 5fdcc763663eefb86a5b8879697aa6088b041e70 "$task_toolchain_root/downloads/commandlinetools-linux-13114758_latest.zip" | sha1sum --check
if ! test -x "$task_toolchain_root/android-sdk/cmdline-tools/19.0/bin/sdkmanager"; then
  task_unpack_dir=$(mktemp -d "$task_toolchain_root/android-sdk/cmdline-tools/unpack.XXXXXX")
  unzip -q "$task_toolchain_root/downloads/commandlinetools-linux-13114758_latest.zip" -d "$task_unpack_dir"
  mv "$task_unpack_dir/cmdline-tools" "$task_toolchain_root/android-sdk/cmdline-tools/19.0"
  rmdir "$task_unpack_dir"
fi
cat > "$task_toolchain_root/android-env.sh" <<'ANDROIDENV'
export JAVA_HOME=/workspace/.toolchains/java21/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME=/workspace/.toolchains/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME=/workspace/.toolchains/android-user
export GRADLE_USER_HOME=/workspace/.toolchains/gradle-home
export PATH="$JAVA_HOME/bin:/workspace/.toolchains/gradle-8.13/bin:$ANDROID_HOME/cmdline-tools/19.0/bin:$ANDROID_HOME/platform-tools:$PATH"
ANDROIDENV
source "$task_toolchain_root/android-env.sh"
python3 - <<'PY'
import os,subprocess,urllib.parse,pathlib
# Gradle's JVM does not automatically use the standard HTTPS_PROXY binding.
proxy=urllib.parse.urlsplit(os.environ.get('HTTPS_PROXY',''))
if proxy.hostname:
    path=pathlib.Path(os.environ['GRADLE_USER_HOME'])/'gradle.properties'
    settings={
        'systemProp.http.proxyHost':proxy.hostname,
        'systemProp.http.proxyPort':str(proxy.port or 80),
        'systemProp.https.proxyHost':proxy.hostname,
        'systemProp.https.proxyPort':str(proxy.port or 80),
        'systemProp.http.nonProxyHosts':'localhost|127.*|[::1]',
    }
    existing=path.read_text().splitlines() if path.exists() else []
    retained=[line for line in existing if line.split('=',1)[0].strip() not in settings]
    path.write_text('\n'.join(retained+[key+'='+value for key,value in settings.items()])+'\n')
args=[os.environ['ANDROID_HOME']+'/cmdline-tools/19.0/bin/sdkmanager','--sdk_root='+os.environ['ANDROID_HOME'],'platforms;android-35','build-tools;35.0.0','platform-tools']
proxy=urllib.parse.urlsplit(os.environ.get('HTTPS_PROXY',''))
if proxy.hostname:
    args+=['--proxy=http','--proxy_host='+proxy.hostname,'--proxy_port='+str(proxy.port or 80)]
# Accept the standard Android SDK dependency license needed for authorized Android development.
subprocess.run(args,input='y\n'*20,text=True,check=True)
PY
javac -version
gradle --version
sdkmanager --sdk_root="$ANDROID_HOME" --list_installed
