# PrismCam

A local CCTV wall. An embedded [go2rtc](https://github.com/AlexxIT/go2rtc) process pulls your RTSP cameras, and the browser plays them with WebRTC (then MSE, then HLS). The same HTTP API is what a later Android or iOS app will use.

## Run

```bash
npm start
```

Open `http://127.0.0.1:8787`. The first launch downloads go2rtc into `data/bin/`. That folder, `data/cameras.yaml`, and `data/config.yaml` stay untracked.

On the server PC the page signs in by itself. From another device on the LAN, paste the token in `data/config.yaml`.

Live is the wall. The 1 / 4 / 9 / 16 control sets the grid; a narrow screen drops to two columns, then one. Tap a tile for the main stream.

Cameras adds or replaces a feed. Pick Hikvision, Ezviz, Tapo, Dahua, Reolink, or paste a raw RTSP URL. Test asks the camera for a picture before Save. Leave the password blank when editing to keep the current one. Save reloads that stream without restarting the restreamer.

The Cameras page also shows the go2rtc version. When GitHub has a newer release, Update downloads it and swaps the binary in place.

Phones on the same Wi-Fi use the LAN address printed at startup. Allow inbound TCP **8787** and TCP/UDP **8555** through Windows Firewall when you connect a phone.

## Docker

One image runs the wall and go2rtc. Put the host machine’s LAN address in `PRISMCAM_PUBLIC_HOST` so phones receive a usable WebRTC address.

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8787`. Camera settings and the API token stay in `./data` on the host. Inside Docker the browser asks for that token; it is in `data/config.yaml`.

Published ports are TCP `8787` for the app, and TCP plus UDP `8555` for video.

## Camera types

The server builds the RTSP path and adds `#transport=tcp`.

| Type | Main | Sub |
| --- | --- | --- |
| Hikvision | `/Streaming/Channels/{ch}01` | `{ch}02` |
| Ezviz | Hikvision-style, `/h264/ch{ch}/main/av_stream`, or a custom path | matching sub path |
| Tapo | `/stream1` | `/stream2` |
| Dahua | `/cam/realmonitor?channel={ch}&subtype=0` | `subtype=1` |
| Reolink | `/h264Preview_{ch}_main` | `_sub` |
| Raw URL | the URL you paste | optional second URL |

Tapo needs the camera's local account, not the cloud login. A camera with no sub URL is re-served locally so the wall and the full-screen view share one camera connection.

`GET /api/v1` is described in [docs/api.md](docs/api.md).
