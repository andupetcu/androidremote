#!/bin/bash
# Start the screen capture server on an Android device
#
# This script deploys the screen-server APK to the device and starts it
# via app_process. The server streams H.264 video over a local socket
# that the main app connects to.
#
# Usage:
#   ./start-screen-server.sh [options]
#
# Options:
#   -m <size>     Max video dimension (default: 1920)
#   -b <rate>     Bitrate in bps (default: 8000000)
#   -f <fps>      Max FPS (default: 60)
#   -s <serial>   ADB device serial (for multi-device)

set -e

# Default values
MAX_SIZE=1920
BITRATE=8000000
MAX_FPS=60
SERIAL=""

# Parse arguments
while getopts "m:b:f:s:h" opt; do
    case $opt in
        m) MAX_SIZE="$OPTARG" ;;
        b) BITRATE="$OPTARG" ;;
        f) MAX_FPS="$OPTARG" ;;
        s) SERIAL="$OPTARG" ;;
        h)
            echo "Usage: $0 [-m maxSize] [-b bitrate] [-f fps] [-s serial]"
            exit 0
            ;;
        *)
            echo "Invalid option: -$OPTARG" >&2
            exit 1
            ;;
    esac
done

# Find the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# APK path (built by Gradle)
APK_PATH="$PROJECT_DIR/screen-server/build/outputs/apk/release/screen-server-release.apk"
if [ ! -f "$APK_PATH" ]; then
    APK_PATH="$PROJECT_DIR/screen-server/build/outputs/apk/debug/screen-server-debug.apk"
fi

if [ ! -f "$APK_PATH" ]; then
    echo "Error: screen-server APK not found. Build it first:"
    echo "  ./gradlew :screen-server:assembleDebug"
    exit 1
fi

# Set ADB serial if specified
ADB_CMD="adb"
if [ -n "$SERIAL" ]; then
    ADB_CMD="adb -s $SERIAL"
fi

echo "Deploying screen-server to device..."
$ADB_CMD push "$APK_PATH" /data/local/tmp/screen-server.apk

echo "Starting screen server..."
echo "  Max size: $MAX_SIZE"
echo "  Bitrate: $BITRATE"
echo "  Max FPS: $MAX_FPS"

# Start the server (runs until killed or client disconnects)
$ADB_CMD shell "CLASSPATH=/data/local/tmp/screen-server.apk \
    app_process / com.androidremote.screenserver.Server \
    -m $MAX_SIZE -b $BITRATE -f $MAX_FPS"
