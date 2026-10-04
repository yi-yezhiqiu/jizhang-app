"""Copy the built APK out of build/ to the project root.

Why a separate script: plain `copy` in a .cmd fails silently when the
destination path contains non-ASCII characters (this workspace is
"D:\\手机记账app"), which once left a stale APK sitting at the root.
Python handles the CJK path reliably and is already required by
normalize_apk.py, so there is no extra dependency.

Usage:
    python copy_apk.py <source.apk> <dest.apk>
"""

import shutil
import sys


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: copy_apk.py <source.apk> <dest.apk>\n")
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    try:
        shutil.copyfile(src, dst)
    except OSError as exc:
        sys.stderr.write("copy failed: %s\n" % exc)
        return 1

    print("copied -> %s" % dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
