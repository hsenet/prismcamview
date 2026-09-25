# PrismCam API

Version: `v1`. Base path: `/api/v1`.

The Android and iOS apps are clients of this API. The phone does not store RTSP passwords and does not talk to the cameras. It asks this server for a camera list and plays the URLs it returns.

## Auth

Every route except loopback session requires:

```
Authorization: Bearer <token>
```

The token is created in `data/config.yaml` on the PC that runs PrismCam. RTSP passwords are never included in a response.

`GET /api/v1/session` returns `{ "ok": true }` and sets an `HttpOnly` `SameSite=Strict` cookie named `prism_session` only when the request comes from `127.0.0.1` and the same site. The token is not included in that response. A page on another website cannot read it. Other devices send the bearer token from `data/config.yaml`. A successful request sets the same cookie, and the browser keeps that instead of storing the token in JavaScript.

The player scripts are public. Stream media under `/rtc/api/` requires the bearer token or the cookie. Creating, deleting, or listing streams is refused. The embedded restreamer itself listens only on `127.0.0.1` and requires its own password, which the Node server holds.

## Cameras

`GET /api/v1/cameras`

```json
{
  "cameras": [
    {
      "id": "hik-169",
      "name": "Hikvision 169",
      "type": "hikvision",
      "host": "192.168.1.169",
      "port": 554,
      "username": "admin",
      "channel": 2,
      "hasPassword": true,
      "maskedUrl": "rtsp://admin:••••@192.168.1.169:554/Streaming/Channels/201#transport=tcp",
      "status": "live",
      "streams": {
        "main": { "webrtc": "", "whep": "", "hls": "", "snapshot": "" },
        "sub": { "webrtc": "", "whep": "", "hls": "", "snapshot": "" }
      }
    }
  ]
}
```

`status` is `live`, `connecting`, or `offline`.

Use `streams.sub` for a grid and `streams.main` when the tile is opened. Play WebRTC first. If the peer connection fails, play HLS. iOS has no Media Source Extensions, so HLS is the fallback there.

- `webrtc` — WebSocket signaling at `/rtc/api/ws?src=<id>`
- `whep` — `POST /rtc/api/webrtc?src=<id>` with an SDP offer (`application/sdp`)
- `hls` — `/rtc/api/stream.m3u8?src=<id>&mp4` (H264 and H265)
- `snapshot` — `/rtc/api/frame.jpeg?src=<id>`

Those playback paths are proxied to the embedded restreamer and require the same sign-in as the rest of the API. WebRTC media uses UDP and TCP port **8555** on the server PC, which the phone must be able to reach.

`GET /api/v1/cameras/:id` returns the same object plus the fields the admin form edits: `pathStyle` (`hikvision`, `h264`, `custom` for Ezviz), `path`, `subPath`, and masked `url` / `subUrl` for a raw RTSP camera.

`POST /api/v1/cameras` creates a camera. `PUT /api/v1/cameras/:id` replaces the feed. Omit `password` or send it blank to keep the stored password. A masked URL that still contains `••••` keeps the stored password. `DELETE /api/v1/cameras/:id` removes the camera and both streams.

Preset `type` values: `hikvision`, `ezviz`, `tapo`, `dahua`, `reolink`, `generic`.

`POST /api/v1/cameras/preview` returns `{ "maskedUrl" }` or `{ "maskedUrl": "", "error" }` and does not save.

`POST /api/v1/cameras/test` uses the same body, does not save, and returns `{ "ok": true, "snapshot": "data:image/jpeg;base64,..." }` or `{ "ok": false, "error" }`.

## Restreamer

`GET /api/v1/go2rtc` returns `{ "version", "latest", "updateAvailable", "running" }`.

`POST /api/v1/go2rtc/update` downloads the newest Windows go2rtc release, swaps the binary, and starts it. A phone does not need this to watch video.
