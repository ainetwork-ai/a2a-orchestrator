#!/bin/sh
# ainize entrypoint: the platform root filesystem is read-only and secrets arrive as
# environment variables, while the app reads its three configuration FILES by path and
# insists they are private (mode 0600/0700-free) and owned by the runtime user.
# Each *_B64 secret is decoded into /tmp/secrets and the matching path variable is set.
set -eu
umask 077
dir=/tmp/secrets
mkdir -p "$dir"

materialize() { # <b64 var> <path var> <file name>
  eval "b64=\${$1:-}"
  if [ -n "$b64" ]; then
    printf '%s' "$b64" | base64 -d > "$dir/$3"
    # A value over the 32 KiB secret limit may be stored gzip-compressed (gzip -9c file | base64 -w0).
    if gzip -t "$dir/$3" 2>/dev/null; then gunzip -c "$dir/$3" > "$dir/$3.tmp" && mv "$dir/$3.tmp" "$dir/$3"; fi
    chmod 600 "$dir/$3"
    export "$2=$dir/$3"
  fi
  unset "$1" b64
}

materialize AIN_STATE_CONFIG_B64 AIN_STATE_CONFIG blockchain-state.json
materialize AINMEM_REPORT_CONFIG_B64 AINMEM_REPORT_CONFIG ainmem-reports.json
materialize AGENT_ENDPOINT_MAP_B64 AGENT_ENDPOINT_MAP agent-endpoints.json

# Any arguments replace the default command (handy for one-off checks).
if [ "$#" -gt 0 ]; then exec "$@"; fi
exec node dist/server.js
