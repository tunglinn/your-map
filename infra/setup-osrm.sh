#!/usr/bin/env bash
# Provisions OSRM (with a bike-safety-tweaked profile) on a fresh Ubuntu droplet.
# Run this ON THE DROPLET (ssh in first), not from your laptop.
# Some steps (cloudflared login/DNS) are interactive and run separately at the bottom.
set -euo pipefail

OSRM_VERSION="v5.27.1"          # pin so profile lib files match the binary
EXTRACT_URL="https://download.geofabrik.de/asia/taiwan-latest.osm.pbf"
WORKDIR="/opt/osrm"

sudo apt-get update
sudo apt-get install -y docker.io git

sudo mkdir -p "$WORKDIR" && cd "$WORKDIR"
sudo curl -L -o taiwan-latest.osm.pbf "$EXTRACT_URL"

# Pull the official routing profiles (bicycle.lua + its lib/ dependencies) at a
# pinned version so they match the osrm-backend docker image below.
sudo git clone --depth 1 --branch "$OSRM_VERSION" https://github.com/Project-OSRM/osrm-backend.git osrm-src
sudo cp -r osrm-src/profiles ./profiles

cat <<'EOF'
--- Manual step: bike-safety tweak ---
Open profiles/bicycle.lua and find the `bicycle_speeds` table. Lower the
speed for busy road classes and raise it for calmer ones, e.g.:

  bicycle_speeds = {
    primary       = 8,   -- was ~15: makes OSRM avoid these unless necessary
    secondary     = 10,  -- was ~17
    tertiary      = 14,  -- was ~18
    residential   = 18,  -- was ~18 (unchanged: this is the "safe" default)
    cycleway      = 20,  -- was ~18: prefer dedicated bike infra
    track         = 16,
  }

OSRM's routing cost is distance/speed, so a *lower* number here makes a road
class more "expensive" to route through, and a *higher* number makes it
preferred. Re-run this script's extract/partition/customize steps below
after any edit to re-bake the graph.
---------------------------------------
EOF
read -p "Press enter once you've edited profiles/bicycle.lua ..."

IMAGE="ghcr.io/project-osrm/osrm-backend:$OSRM_VERSION"
sudo docker run -t -v "$WORKDIR:/data" "$IMAGE" osrm-extract -p /data/profiles/bicycle.lua /data/taiwan-latest.osm.pbf
sudo docker run -t -v "$WORKDIR:/data" "$IMAGE" osrm-partition /data/taiwan-latest.osrm
sudo docker run -t -v "$WORKDIR:/data" "$IMAGE" osrm-customize /data/taiwan-latest.osrm

# Bind to loopback only: the box's public IP should never serve routing
# directly. The Cloudflare Tunnel (same machine) reaches it via localhost.
sudo docker run -d --name osrm --restart unless-stopped -p 127.0.0.1:5000:5000 \
  -v "$WORKDIR:/data" "$IMAGE" osrm-routed --algorithm mld /data/taiwan-latest.osrm

echo "OSRM running on localhost:5000 (not exposed publicly yet). Test with:"
echo "  curl 'http://localhost:5000/route/v1/bike/121.53,25.03;121.57,25.05'"

cat <<'EOF'

--- Manual step: expose via Cloudflare Tunnel (dashboard-driven, no config file to hand-write) ---
1. Zero Trust dashboard (one.dash.cloudflare.com) -> Networks -> Tunnels ->
   Create a tunnel -> Cloudflared -> name it "osrm".
2. Run the install commands it shows you for this OS, ending in:
     sudo cloudflared service install <TOKEN>
   (this registers it as a systemd service - survives reboots automatically)
3. On that tunnel, add a Public Hostname: your subdomain + domain, Service
   type HTTP, URL "localhost:5000".
4. From ANOTHER machine (not the droplet): curl https://<your-hostname>/route/v1/bike/121.53,25.03;121.57,25.05
   Once that works, the docker run above already has the public port closed
   (127.0.0.1-only bind), so no DigitalOcean firewall rule is needed.
---------------------------------------
EOF
