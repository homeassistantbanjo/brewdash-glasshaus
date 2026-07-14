# Taplist — bar-top kiosk (Pi 5)

The public **On Tap** display. Distinct from the keg management board (GlassHaus Kegs tab)
and the QR scan pages — this is a read-only, glanceable, non-touch screen for the bar.

## The URL
```
http://192.168.50.118:8097/taplist       # LAN
https://unraid.tail229434.ts.net/taplist  # via Tailscale (once `tailscale serve` is set up)
```
Shows: what's ON TAP now (each tapped keg → tap #, beer name, style, ABV) + a "Coming Soon"
panel (Brewfather batches in Fermenting/Conditioning → name · style · FG · ~ETA). The page
auto-refreshes every 60s, so it stays current with zero interaction.

Data notes:
- "On Tap" = kegs with status `tapped` in the keg service. Tap a keg (Kegs board or QR page)
  and it appears here within a refresh.
- "Coming Soon" pulls from the Brewfather sidecar (:8093). It only lists batches Brewfather
  itself marks Fermenting/Conditioning — if BF shows them as Planning, they won't appear
  (that's a BF-status question, not a taplist bug). ETA shows only when HA's projected-FG
  sensor has a live value; otherwise it's omitted rather than faked.
- If Brewfather or HA is unreachable, "Coming Soon" is simply hidden — the on-tap board
  still renders. The display never breaks on a data-source outage.

## Pi 5 kiosk setup (Raspberry Pi OS)
Boot the Pi straight into a fullscreen Chromium pointed at the taplist. Minimal approach:

1. Install Chromium + a lightweight session (if not on the desktop image):
   ```
   sudo apt update && sudo apt install -y chromium-browser unclutter
   ```
2. Autostart in kiosk mode. Create `~/.config/autostart/taplist.desktop`:
   ```
   [Desktop Entry]
   Type=Application
   Name=Taplist
   Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars \
     --disable-session-crashed-bubble --incognito \
     --check-for-update-interval=31536000 \
     http://192.168.50.118:8097/taplist
   ```
   `unclutter` hides the mouse cursor on an idle non-touch screen:
   `unclutter -idle 0.1 &` (add to autostart too).
3. Disable screen blanking (so the bar display stays on):
   ```
   # in /etc/lightdm/lightdm.conf under [Seat:*]:
   xserver-command=X -s 0 -dpms
   ```
   or, on Wayland/labwc, set the compositor's idle/DPMS timeout to never.
4. Point Chromium zoom / the Pi's resolution to the bar screen; the page uses vh/vw units
   so it scales to whatever the display is (landscape assumed).

The page is self-contained HTML (no build step, no app). To change the layout, edit
`taplistHtml()` in server.mjs and redeploy the keg service.

## Co-hosting the watchdog (later)
The Pi 5 can run the external HausWatch watchdog as a background service while it drives the
kiosk in the foreground — the two don't conflict (see the HausWatch Pi-5 watchdog plan).
