"""aiohttp web server: serves the static dashboard and a /ws WebSocket feed.

Runs in the same asyncio loop as the data source. Each connected page registers
with the hub, receives an immediate snapshot, then streams live events.
"""
import asyncio
import json
import os
import time

from aiohttp import web, WSMsgType

import recordings

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def make_app(hub, log=print):
    app = web.Application()
    app["hub"] = hub
    app["log"] = log
    app["ws_seq"] = 0
    app.router.add_get("/", _index)
    app.router.add_get("/ws", _ws_handler)
    app.router.add_get("/review", _review)
    app.router.add_get("/daily", _daily)
    app.router.add_get("/morph", _morph)
    app.router.add_get("/report", _report)
    app.router.add_get("/ectopy", _ectopy_page)
    app.router.add_get("/api/current", _current)
    app.router.add_get("/api/sessions", _sessions)
    app.router.add_get("/api/sessions/{id}", _session)
    app.router.add_get("/api/sessions/{id}/ecg", _session_ecg)
    app.router.add_get("/api/rest", _rest)
    app.router.add_get("/api/alternans", _alternans_all)
    app.router.add_get("/api/sessions/{id}/alternans", _alternans_get)
    app.router.add_put("/api/sessions/{id}/alternans", _alternans_put)
    app.router.add_get("/api/sessions/{id}/events", _events_get)
    app.router.add_post("/api/sessions/{id}/events", _events_add)
    app.router.add_post("/api/sessions/{id}/clip", _clip)
    app.router.add_static("/static/", STATIC_DIR, name="static")
    app.on_response_prepare.append(_no_cache)
    return app


async def _no_cache(request, response):
    """Make the browser revalidate the dashboard files on every load, so a
    `git pull` takes effect on a normal reload (no stale cached app.js)."""
    if request.path in ("/", "/review", "/daily", "/morph", "/report", "/ectopy") or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"


def _agent(request):
    ua = request.headers.get("User-Agent", "")
    for name in ("Firefox", "Edg", "Chrome", "Safari", "Python", "curl"):
        if name in ua:
            return "Edge" if name == "Edg" else name
    return ua[:24] or "no user agent"


async def _index(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))


async def _review(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "review.html"))


async def _daily(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "daily.html"))


async def _morph(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "morph.html"))


async def _report(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "report.html"))


async def _ectopy_page(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "ectopy.html"))


def _outdir(request):
    return request.app["hub"].recorder.outdir


async def _current(request):
    """The session being recorded now (the live RR histogram fills from it)."""
    return web.json_response({"id": request.app["hub"].recorder.session})


async def _sessions(request):
    """Saved sessions, newest first (review page)."""
    return web.json_response(await asyncio.to_thread(recordings.list_sessions, _outdir(request)))


async def _session(request):
    """One session's beats, ectopy events and activity (review page)."""
    try:
        data = await asyncio.to_thread(recordings.load_session, _outdir(request), request.match_info["id"])
    except ValueError:
        raise web.HTTPBadRequest(text="bad session id")
    except FileNotFoundError:
        raise web.HTTPNotFound(text="no such session")
    return web.json_response(data, dumps=lambda o: json.dumps(o, separators=(",", ":")))


async def _session_ecg(request):
    """Raw ECG + accelerometer of a time window ?a=&b= (unix s) of a session (review strip)."""
    try:
        a, b = float(request.query["a"]), float(request.query["b"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(text="a and b (unix seconds) needed")
    try:
        data = await asyncio.to_thread(recordings.raw_window, _outdir(request), request.match_info["id"], a, b)
    except ValueError:
        raise web.HTTPBadRequest(text="bad session id")
    except FileNotFoundError:
        raise web.HTTPNotFound(text="no ECG for this session")
    return web.json_response(data, dumps=lambda o: json.dumps(o, separators=(",", ":")))


async def _rest(request):
    """Resting windows of all sessions (daily summary page)."""
    data = await asyncio.to_thread(recordings.rest_windows, _outdir(request))
    return web.json_response(data, dumps=lambda o: json.dumps(o, separators=(",", ":")))


def _json(data):
    return web.json_response(data, dumps=lambda o: json.dumps(o, separators=(",", ":")))


async def _guard(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e))


async def _alternans_all(request):
    """Every session's rr file stat and cached alternans summary (daily view, batch scan)."""
    return _json(await _guard(recordings.alternans_all, _outdir(request)))


async def _alternans_get(request):
    return _json(await _guard(recordings.alternans_get, _outdir(request), request.match_info["id"]))


async def _alternans_put(request):
    try:
        data = await request.json()
    except ValueError:
        raise web.HTTPBadRequest(text="JSON body needed")
    await _guard(recordings.alternans_put, _outdir(request), request.match_info["id"], data)
    return _json({"ok": True})


async def _events_get(request):
    return _json(await _guard(recordings.events_get, _outdir(request), request.match_info["id"]))


async def _events_add(request):
    """A user event (Mark event, a note). With "clip": [before, after] s, the streams
    around it are also copied to a clip folder once `after` has passed."""
    try:
        ev = await request.json()
        float(ev.get("t"))
    except (ValueError, TypeError, AttributeError):
        raise web.HTTPBadRequest(text="JSON body with t needed")
    ses = request.match_info["id"]
    saved = await _guard(recordings.events_add, _outdir(request), ses, ev)
    clip = ev.get("clip")
    if clip:
        t = saved["t"]
        name = time.strftime("%H%M%S", time.localtime(t)) + "_" + saved["kind"]
        _schedule_clip(request.app, ses, t - float(clip[0]), t + float(clip[1]), name, saved)
    return _json(saved)


async def _clip(request):
    """Copy [a, b] of every stream of the session to a clip folder (an alternans episode
    +- 30 s); waits until b has passed when the session is being recorded."""
    try:
        d = await request.json()
        a, b, name = float(d["a"]), float(d["b"]), str(d["name"])
    except (ValueError, TypeError, KeyError):
        raise web.HTTPBadRequest(text="a, b and name needed")
    if not (0 < b - a <= 3 * 3600):
        raise web.HTTPBadRequest(text="bad range")
    _schedule_clip(request.app, request.match_info["id"], a, b, name, d.get("info"))
    return _json({"ok": True, "due": b})


def _schedule_clip(app, ses, a, b, name, info):
    log = app["log"]
    outdir = app["hub"].recorder.outdir

    async def job():
        await asyncio.sleep(max(0.0, b + 3 - time.time()))   # the recorder flushes every packet
        try:
            d = await asyncio.to_thread(recordings.write_clip, outdir, ses, a, b, name, info)
            if d:
                log(f"clip saved: {d}")
        except (ValueError, OSError) as e:
            log(f"clip {ses}_{name} failed: {e}")
    tasks = app.setdefault("clip_tasks", set())
    task = asyncio.ensure_future(job())
    tasks.add(task)
    task.add_done_callback(tasks.discard)


async def _ws_handler(request):
    hub = request.app["hub"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    # who is talking: several pages (and scripts) can be attached to one backend,
    # and any of them may send connect / disconnect -- name them in the log
    request.app["ws_seq"] += 1
    who = f"client #{request.app['ws_seq']} ({_agent(request)}, {request.remote})"
    log = request.app["log"]
    hub.add_client(ws)
    log(f"{who} attached; {len(hub.clients)} client(s)")
    # immediate snapshot so a reloaded page isn't blank
    for msg in hub.snapshot_messages():
        await ws.send_str(msg)
    try:
        async for m in ws:
            if m.type == WSMsgType.ERROR:
                break
            if m.type == WSMsgType.TEXT:     # control: connect / disconnect / scan
                try:
                    msg = json.loads(m.data)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    if msg.get("cmd"):
                        log(f"{who}: {msg.get('cmd')}")
                    hub.command(msg)
    finally:
        hub.remove_client(ws)
        log(f"{who} detached; {len(hub.clients)} client(s)")
    return ws


async def start_server(app, host, port):
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    return runner
