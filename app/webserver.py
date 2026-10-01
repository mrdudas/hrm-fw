"""aiohttp web server: serves the static dashboard and a /ws WebSocket feed.

Runs in the same asyncio loop as the data source. Each connected page registers
with the hub, receives an immediate snapshot, then streams live events.
"""
import json
import os

from aiohttp import web, WSMsgType

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def make_app(hub):
    app = web.Application()
    app["hub"] = hub
    app.router.add_get("/", _index)
    app.router.add_get("/ws", _ws_handler)
    app.router.add_static("/static/", STATIC_DIR, name="static")
    app.on_response_prepare.append(_no_cache)
    return app


async def _no_cache(request, response):
    """Make the browser revalidate the dashboard files on every load, so a
    `git pull` takes effect on a normal reload (no stale cached app.js)."""
    if request.path == "/" or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"


async def _index(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))


async def _ws_handler(request):
    hub = request.app["hub"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    hub.add_client(ws)
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
                    hub.command(msg)
    finally:
        hub.remove_client(ws)
    return ws


async def start_server(app, host, port):
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    return runner
