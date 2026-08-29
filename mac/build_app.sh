#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
status_url=${TIBOTOKENS_STATUS_URL:-http://127.0.0.1:3000/status}
manual_check_token=${TIBOTOKENS_MANUAL_CHECK_TOKEN:-local-development-token-change-me}

case "$status_url" in
    https://*/status)
        authority=${status_url#https://}
        authority=${authority%/status}
        case "$authority" in
            ""|.*|*.|*..*|*[!A-Za-z0-9.-]*)
                echo "TIBOTOKENS_STATUS_URL has an invalid HTTPS host" >&2
                exit 1
                ;;
        esac
        ;;
    http://localhost/status|http://127.0.0.1/status) ;;
    http://localhost:*/status|http://127.0.0.1:*/status)
        authority=${status_url#http://}
        authority=${authority%/status}
        port=${authority##*:}
        case "$port" in
            ""|*[!0-9]*)
                echo "TIBOTOKENS_STATUS_URL has an invalid local port" >&2
                exit 1
                ;;
        esac
        if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
            echo "TIBOTOKENS_STATUS_URL has an invalid local port" >&2
            exit 1
        fi
        ;;
    *)
        echo "TIBOTOKENS_STATUS_URL must be an HTTPS /status URL or local HTTP /status URL" >&2
        exit 1
        ;;
esac

if [ "${#manual_check_token}" -lt 32 ]; then
    echo "TIBOTOKENS_MANUAL_CHECK_TOKEN must be at least 32 characters" >&2
    exit 1
fi
case "$status_url" in
    https://*)
        if [ "$manual_check_token" = "local-development-token-change-me" ]; then
            echo "Set a private TIBOTOKENS_MANUAL_CHECK_TOKEN for a production build" >&2
            exit 1
        fi
        ;;
esac

cd "$script_dir"
swift build
binary_dir=$(swift build --show-bin-path)
app_dir="$script_dir/.build/app/Tibotokens.app"
contents_dir="$app_dir/Contents"

rm -rf "$app_dir"
mkdir -p "$contents_dir/MacOS"
mkdir -p "$contents_dir/Resources"
cp "$binary_dir/Tibotokens" "$contents_dir/MacOS/Tibotokens"
cp "$script_dir/Info.plist" "$contents_dir/Info.plist"
cp "$script_dir/Resources/tibo_menu_icon.png" "$contents_dir/Resources/tibo_menu_icon.png"
/usr/bin/plutil -replace TibotokensStatusURL -string "$status_url" "$contents_dir/Info.plist"
/usr/bin/plutil -replace TibotokensManualCheckToken -string "$manual_check_token" "$contents_dir/Info.plist"
/usr/bin/codesign --force --sign - --timestamp=none "$app_dir"
/usr/bin/codesign --verify --deep --strict "$app_dir"

echo "$app_dir"
