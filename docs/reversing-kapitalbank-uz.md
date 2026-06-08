# Reverse-Engineering KapitalBank-UZ (and Uzbek bank apps in general)

How to keep the `kapitalbank-uz` ZenPlugin working against the private mobile API
`https://b2c-api.kapitalbank.uz/api/v1`. The bank ships no public/open-banking API — the
plugin replays the exact requests the official Android app (`uz.kapitalbank.kbonline`)
makes. When the app updates and the plugin breaks, you re-capture traffic, diff the headers,
and patch the plugin.

This doc is the methodology. The plugin lives in
`src/services/bank/ZenPlugins/src/plugins/kapitalbank-uz/`
(`api.js` = endpoints + headers, `index.js` = auth orchestration, `converters.js` = mapping).

---

## TL;DR of the pain points

1. **Hard device-fingerprint headers.** The server validates `X-App-Version`, `X-Device-Info`,
   `User-Agent: okhttp/<exact version>`. Wrong version → `426 Upgrade Required`. These are the
   #1 source of breakage and must be copied from a fresh APK / live capture.
2. **myId face identification on every new device.** Since ~2024 a first login from an
   unrecognized `DeviceId` forces identity verification through `myid.uz` (PINFL + birth date +
   a live camera photo). This is why first-run auth is a multi-step dance and why automated
   first-run is effectively impossible without a real photo.
3. **426 version treadmill.** Every few app releases the minimum supported version bumps. You
   must re-read the version from a current APK, not guess.

---

## Concrete setup (this dev machine)

The values used historically, so you don't re-derive them each time:

- **Interceptor:** mitmproxy installed at `~/.local/bin/{mitmproxy,mitmweb,mitmdump}`. CA certs
  in `~/.mitmproxy/` (`mitmproxy-ca-cert.pem` etc.) — already trusted on the test phone.
- **Mac LAN IP:** `192.168.0.18`. Proxy port used: **`8082`** (non-standard, picked to avoid
  clashes). The phone gets `192.168.0.18:8082`.
- **Test phone:** Samsung (Android 13), adb serial `RZ8R72YBZXL`. No sniffer app installed —
  capture is purely via the adb-set system proxy. The bot's device fingerprint mimics a Samsung
  `o1s` / `SM-G991B` (see `X-Device-Info` and the shim `device` block).
- **Test credentials:** in `.env` as `ZEN_TEST_*` (`ZEN_TEST_PHONE`, `ZEN_TEST_PASSWORD`, plus
  `ZEN_TEST_PINFL`, `ZEN_TEST_BDAY`, `ZEN_TEST_ISRESIDENT` for the myId path). `--env-prefix
  ZEN_TEST` maps them to plugin preferences automatically.

---

## Tooling

### Traffic capture: mitmproxy + adb global proxy (the setup that already exists here)

This is what was used historically (CA certs in `~/.mitmproxy` on the dev Mac). The Android
phone is **not** running any sniffer app — capture is done entirely via a system-wide proxy
pointed at desktop mitmproxy.

```bash
# 1. start the interceptor on the Mac (Mac LAN IP was 192.168.0.18, port 8082)
mitmweb --listen-port 8082        # web UI on http://localhost:8081

# 2. point the phone's whole system at it (over adb — no app needed)
adb shell settings put global http_proxy 192.168.0.18:8082

# 3. ... reproduce the login / sync in the bank app, watch requests in mitmweb ...

# 4. WHEN DONE — ALWAYS clear the proxy, or the phone "loses internet"
adb shell settings put global http_proxy :0
```

**Gotcha (cost me a debugging session): the adb global proxy is sticky.** It survives mitmproxy
restarts and phone reboots. If you stop mitmproxy but leave the proxy set, every app on the
phone tries to reach a dead port and the phone looks like it has no internet (ICMP/ping still
works, so it's confusing). Diagnose and fix:

```bash
adb shell settings get global http_proxy      # if not ":0", that's your culprit
adb shell settings put global http_proxy :0
```

mitmproxy's CA must be trusted on the phone to read HTTPS. On modern Android a user-installed CA
is **not** trusted by apps by default — see cert pinning below.

### APK decompilation: jadx

Used to confirm the okhttp version and header formats directly from the binary (e.g. commit
`beea6f4c` "bump okhttp User-Agent to 5.3.2 (verified from APK)").

```bash
# pull the installed APK off the phone
adb shell pm path uz.kapitalbank.kbonline      # prints the apk path(s)
adb pull /data/app/.../base.apk kb.apk
jadx -d kb-src kb.apk                            # or open in jadx-gui
```

What to grep for in the decompiled source:
- **okhttp version** → `User-Agent`. Search the bundled okhttp for its version string, or look
  at `META-INF` / the okhttp `userAgent` constant. The app sends `okhttp/<X.Y.Z>` literally.
- **App version string** → how it builds `X-App-Version` / `X-Device-Info`. The server parses
  `X-App-Version` as `"Android; X.Y.Z"` and does `substringBefore("-")`, so the build suffix is
  stripped (see `api.js`: `appVersionFull.split('-')[0]`).
- **Header construction** → exact casing and order of `DeviceId`, `X-Device-OS`, `X-Trace-Info`.
- **Endpoints & request bodies** → the `/auth/*`, `/identification/my-id/*`, `/cards`, `/accounts`,
  `/deposits`, `/history/transactions` shapes.

### Cert pinning bypass: frida (only if the app pins)

If mitmproxy shows TLS handshakes failing even with the CA trusted, the app pins certificates.
Bypass with frida + a standard okhttp/TrustManager unpinning script on a rooted device or a
patched (objection / frida-gadget-injected) APK:

```bash
frida -U -f uz.kapitalbank.kbonline -l frida-okhttp-unpin.js --no-pause
```

A `network_security_config.xml` with a user-CA `<trust-anchors>` baked into a re-signed APK is
the non-root alternative.

---

## The auth flow (what the plugin replays)

All requests carry the device-fingerprint headers from `getDefaultHeaders()` in `api.js`:

```
Content-Type: application/json
Accept-Encoding: gzip
Accept-Language: ru-RU
Connection: Keep-Alive
DeviceId: <random 16-char, generated once on first run, persisted>
Host: b2c-api.kapitalbank.uz
User-Agent: okhttp/5.3.2                          # MUST match the APK's okhttp
X-App-Version: 3.5.1                              # appVersion without build suffix
X-Device-Info: Android; 13; samsung; o1s; 3.5.1; XXHDPI; <DeviceId>
X-Device-OS: ANDROID
X-Trace-Info: sessionId=<persisted> requestId=<uuid v4 per request>
```

Sequence (`index.js` → `api.js`):

1. **`GET /auth/phone-number/{phone}`** → `{ exist: bool }`. No account → `InvalidLoginOrPasswordError`.
2. **`POST /auth/by-password`** `{ phoneNumber, password, otpSendingSource: "SMS", applicationId: "uz.kapitalbank.kbonline" }`
   - `400` → wrong login/password (`InvalidLoginOrPasswordError`).
   - `403` → **myId identification required** (`TemporaryError` with the bank's `errorDetail`).
   - `200` → returns `verificationCode` (used to confirm the SMS OTP).
3. **`POST /auth/verify-by-password`** `{ verificationCode, otpCode }` → `{ guid, accessToken, refreshToken }`.
   The OTP comes from `ZenMoney.readLine('Введите код из СМС сообщения')`.
4. Subsequent calls use `Authorization: Bearer <accessToken>`.
5. **Token refresh:** `POST /auth/tokens/re-creation` with `Authorization: Bearer <refreshToken>`.
   On sync, the plugin tries `doScrape`; on failure it tries `refreshToken`; if that fails it
   does a full re-auth (`updateToken`).

### The myId branch (the hard part)

When `/auth/by-password` returns `403`, a new-device identity check is required:

1. `POST /identification/my-id/identify` `{ isResident, pinfl, passportSerial: null, passportNumber: null, birthDate, photoFromCamera: { front: <base64 jpeg> } }` → `{ jobId }`.
   - `birthDate` must be `yyyy-MM-dd`. The preference stores `DDMMYYYY` (e.g. `01011990`); `api.js`
     converts it (commit `748503ee`).
   - The photo is a **live camera capture** resized to 480×640, base64 without the
     `data:image/jpeg;base64,` URI prefix (`blobToBase64WithResolution` in `index.js`).
2. Poll `GET /identification/my-id/verify-result/{jobId}` (with a 2s then 5s backoff) until success.
3. Then retry steps 2–3 of the normal auth flow.

**Implication for automation:** first-run auth on a brand-new `DeviceId` cannot be fully
automated — it needs a real face photo through `ZenMoney.takePicture`. In the bot's sync mode
`takePicture` throws (no camera). So: do the **first** login on a device/run that can supply the
photo, persist the `DeviceId` + tokens, and let subsequent syncs reuse them. Keep the `DeviceId`
stable — changing it re-triggers myId.

---

## When the plugin breaks: triage order

1. **`426` anywhere** → version bump. Re-read the app version + okhttp version from a fresh APK
   (jadx), update `appVersionFull` and the `User-Agent` in `api.js`. History of this treadmill:
   `dcafb573`, `700d6d2b`, `627f6267`, `081ea028`, `beea6f4c`.
2. **`403` on `/auth/by-password`** → myId re-identification triggered (new device / bank policy).
   Not a bug — the user must pass myId again. Make sure the error surfaces the bank's `errorDetail`.
3. **`400` on `/auth/by-password`** → genuinely wrong credentials.
4. **TLS handshake fails in mitmproxy** → cert pinning; use frida/objection.
5. **New/changed fields in responses** → capture live, diff against `converters.js`, update the
   mapping. Add converter tests (see the fix plan `docs/plans/2026-05-21-uzum-kapitalbank-fix.md`).

Always verify header **format and casing** against a live capture — the server is picky (commit
`45ef2c69` "fix header formats and add missing auth fields").

---

## Verifying a fix end-to-end (CLI runner)

Don't ship a plugin fix without running it against the real API. `scripts/zen-run.ts` runs a
plugin without the bot, with credentials pulled from `.env` via `--env-prefix`:

```bash
# credentials live in .env as ZEN_TEST_PHONE, ZEN_TEST_PASSWORD, ZEN_TEST_PINFL, ZEN_TEST_BDAY ...
bun scripts/zen-run.ts kapitalbank-uz --env-prefix ZEN_TEST --from 2024-01-01
```

**OTP / myId caveat:** the Bash tool runs with closed stdin, so `ZenMoney.readLine` (the SMS
prompt) fails immediately, and `takePicture` (myId photo) is unsupported in CLI mode. A first-run
login that needs an SMS code or myId photo **must** be run by the user in a real terminal:

> Run in your interactive prompt: `! bun scripts/zen-run.ts kapitalbank-uz --env-prefix ZEN_TEST`
> When the SMS arrives, type it at the `[OTP]` prompt. Log lands in `logs/zen-run/`.

The bank rate-limits OTP requests (~3/min → `otp_already_requested`). Don't spam the runner —
each run sends a real SMS.

A fix is not done until a CLI run completes without errors and returns ≥1 account.

---

## PR workflow

Fixes go upstream to `zenmoney/ZenPlugins`. Follow the submodule fork workflow in the repo
`CLAUDE.md` ("Submodule Fork Workflow" + "develop Branch"): branch from upstream master, one PR
per bank, run `/ultrareview` + `codex exec review` before opening, draft PR via
`gh pr create --repo zenmoney/ZenPlugins --head alex-mextner:<branch> --draft`.

When codex/review flags something that contradicts primary-source evidence (jadx decompilation
or a live capture), document why it's a false positive in the PR — don't revert a correct fix.
```
