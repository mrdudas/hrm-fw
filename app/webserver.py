"""aiohttp web server: serves the static dashboard and a /ws WebSocket feed.

Runs in the same asyncio loop as the data source. Each connected page registers
with the hub, receives an immediate snapshot, then streams live events.
"""
import asyncio
import json
import os

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
    app.router.add_get("/api/sessions", _sessions)
    app.router.add_get("/api/sessions/{id}", _session)
    app.router.add_static("/static/", STATIC_DIR, name="static")
    app.on_response_prepare.append(_no_cache)
    return app


async def _no_cache(request, response):
    """Make the browser revalidate the dashboard files on every load, so a
    `git pull` takes effect on a normal reload (no stale cached app.js)."""
    if request.path in ("/", "/review") or request.path.startswith("/static/"):
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


def _outdir(request):
    return request.app["hub"].recorder.outdir


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
