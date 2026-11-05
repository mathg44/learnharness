#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
# Stay non-root. Named volumes inherit the image directory's 1000:1000 owner.
# A bad bind-mount owner must fail, not trigger a recursive chown on host data.
for directory in "$LH_DATA_DIR" "$(dirname "$LH_AUTH_FILE")"; do
    test -d "$directory" && test -w "$directory" || {
        printf 'App data/auth directories must be writable by UID 1000.\n' >&2
        exit 1
    }
done
exec "$@"
