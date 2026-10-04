"""Normalize ZIP entry names inside an APK.

Why this exists:
    On Windows, aapt2 writes asset entries into the APK using backslash
    separators ("assets/www\\index.html"). The ZIP spec and Android's own
    asset lookup both require forward slashes, so the WebView asks for
    "file:///android_asset/www/index.html" and gets net::ERR_FILE_NOT_FOUND
    even though the file is physically present in the APK.

    This script rewrites the archive with forward slashes. It runs BEFORE
    zipalign and apksigner, so signing still covers the final bytes.

Usage:
    python normalize_apk.py <in.apk> <out.apk>
"""

import sys
import zipfile


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: normalize_apk.py <in.apk> <out.apk>\n")
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    fixed = 0
    total = 0

    with zipfile.ZipFile(src, "r") as zin:
        with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                total += 1
                name = item.filename.replace("\\", "/")
                if name != item.filename:
                    fixed += 1

                # Copy the entry verbatim; preserve the compression type so
                # already-stored entries (like resources.arsc) stay stored.
                data = zin.read(item.filename)
                new_item = zipfile.ZipInfo(name, date_time=item.date_time)
                new_item.compress_type = item.compress_type
                new_item.external_attr = item.external_attr
                new_item.internal_attr = item.internal_attr
                new_item.create_system = item.create_system
                zout.writestr(new_item, data)

    print("entries=%d normalized=%d" % (total, fixed))
    if fixed == 0:
        print("note: nothing needed normalizing")
    # List asset entries so the build log proves the fix landed
    with zipfile.ZipFile(dst, "r") as z:
        for item in z.infolist():
            if item.filename.startswith("assets/"):
                print("  %s" % item.filename)
    return 0


if __name__ == "__main__":
    sys.exit(main())
